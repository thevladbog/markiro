import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { CABINET_CAPABILITY, parseImportGtins } from "@markiro/domain";
import {
  importItemsQuerySchema,
  importSelectionSchema,
  importStartSchema,
  type ImportItem,
  type ImportItemsQuery,
  type ImportSelection,
  type ImportSession,
  type ImportStart,
} from "@markiro/platform-contracts";
import {
  ConflictException,
  ForbiddenException,
  GoneException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { AuthorizationService } from "../../authorization/authorization.service";
import type { EntitlementsService } from "../../subscriptions/entitlements.service";
import { chzSignerSettingsSchema } from "../integrations/channel-registry";
import {
  feedItems,
  formatCatalogDate,
  invalidItem,
  listItems,
  missingItem,
  newStep,
  pageHash,
  parseCheckpoint,
  splitCatalogInterval,
} from "./national-catalog-enumeration";
import type {
  CatalogWork,
  DbTx,
  ImportActor,
  ImportCheckpoint,
  ImportFeatures,
  ImportItemRow,
  ImportItemWrite,
  ImportSessionRow,
} from "./national-catalog-import.types";
import type { NationalCatalogImportRepository } from "./national-catalog-import.repository";
import {
  CatalogRequestError,
  type NationalCatalogRequestCoordinator,
} from "./national-catalog-request-coordinator";
import type { NationalCatalogClient } from "./national-catalog.client";
import type {
  NationalCatalogListResult,
  NationalCatalogProductsResponse,
  NationalCatalogResult,
} from "./national-catalog.types";

/** Internal service only. Task11 registers HTTP/jobs and derives flags from env. */
export class NationalCatalogImportService {
  constructor(
    private readonly repository: NationalCatalogImportRepository,
    private readonly client: Pick<NationalCatalogClient, "listOwnProducts" | "getFeedProducts">,
    private readonly coordinator: NationalCatalogRequestCoordinator,
    private readonly authorization: AuthorizationService,
    private readonly entitlements: EntitlementsService,
    private readonly features: ImportFeatures = { ownCatalog: false, gtinLookup: false },
  ) {}
  async start(actor: ImportActor, body: ImportStart): Promise<ImportSession> {
    const parsed = importStartSchema.safeParse(body);
    if (!parsed.success) throw new UnprocessableEntityException("invalid_import_start");
    return this.repository.transaction(async (tx) => {
      const environment = await this.authorize(tx, actor, parsed.data.mode);
      const now = new Date();
      const boundary = Math.floor(now.getTime() / 1000) * 1000;
      const inputs =
        parsed.data.mode === "gtins"
          ? parseImportGtins(parsed.data.text)
          : { gtins: [], invalid: [] };
      const work: CatalogWork[] =
        parsed.data.mode === "own_catalog"
          ? [{ kind: "list", from: 0, to: boundary, offset: 0, hashes: [] }]
          : Array.from({ length: Math.ceil(inputs.gtins.length / 25) }, (_, index) => ({
              kind: "gtins",
              gtins: inputs.gtins.slice(index * 25, index * 25 + 25),
            }));
      const checkpoint: ImportCheckpoint = {
        version: 1,
        stepId: randomUUID(),
        runId: null,
        phase: work.length ? "primary" : "done",
        work,
        failures: [],
        attempts: 0,
        state: work.length ? "pending" : "done",
        nextRetryAt: null,
        enqueuePending: work.length > 0,
      };
      const session = await this.repository.create(tx, {
        ...actor,
        actorId: actor.userId,
        environment,
        mode: parsed.data.mode,
        startedAt: now,
        throughAt: new Date(boundary),
        expiresAt: new Date(now.getTime() + 86_400_000),
        checkpoint,
        state: work.length ? "queued" : "ready",
        complete: !work.length,
      });
      if (!inputs.invalid.length) return this.summary(tx, session);
      const counts = await this.repository.upsert(
        tx,
        session,
        inputs.invalid.map((value) => invalidItem(value)),
      );
      return this.summary(tx, await this.repository.save(tx, session, counts));
    });
  }
  async read(tenantId: string, sessionId: string): Promise<ImportSession> {
    return this.repository.transaction(async (tx) =>
      this.summary(tx, await this.expire(tx, await this.repository.lock(tx, tenantId, sessionId))),
    );
  }
  async items(
    tenantId: string,
    sessionId: string,
    query: ImportItemsQuery,
  ): Promise<{ items: ImportItem[]; nextCursor: string | null }> {
    const parsed = importItemsQuerySchema.safeParse(query);
    if (!parsed.success) throw new UnprocessableEntityException("invalid_items_query");
    return this.repository.transaction(async (tx) => {
      await this.expire(tx, await this.repository.lock(tx, tenantId, sessionId));
      const rows = await this.repository.list(tx, tenantId, sessionId, parsed.data);
      const visible = rows.slice(0, parsed.data.limit);
      const last = visible.at(-1);
      return {
        items: visible.map(itemDto),
        nextCursor:
          rows.length > parsed.data.limit && last
            ? Buffer.from(
                JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
              ).toString("base64url")
            : null,
      };
    });
  }
  async select(
    actor: ImportActor,
    sessionId: string,
    body: ImportSelection,
  ): Promise<ImportSession> {
    const parsed = importSelectionSchema.safeParse(body);
    if (!parsed.success) throw new UnprocessableEntityException("invalid_selection");
    return this.repository.transaction(async (tx) => {
      const session = await this.repository.lock(tx, actor.tenantId, sessionId);
      await this.assertSessionAccess(tx, actor, session);
      if (session.revision !== body.expectedRevision)
        throw new ConflictException("session_revision_conflict");
      await this.repository.choose(tx, session, parsed.data.itemIds);
      return this.summary(
        tx,
        await this.repository.save(tx, session, { selected: parsed.data.itemIds.length }),
      );
    });
  }
  async cancel(actor: ImportActor, sessionId: string): Promise<ImportSession> {
    return this.repository.transaction(async (tx) => {
      const session = await this.expire(
        tx,
        await this.repository.lock(tx, actor.tenantId, sessionId),
      );
      if (session.state === "cancelled" || session.state === "expired")
        return this.summary(tx, session);
      await this.authorize(tx, actor, session.mode, session.environment);
      const checkpoint = parseCheckpoint(session.checkpoint);
      return this.summary(
        tx,
        await this.repository.save(tx, session, {
          state: "cancelled",
          cancelledAt: new Date(),
          checkpoint: { ...checkpoint, enqueuePending: false },
        }),
      );
    });
  }
  /** Explicit manual retry only. Redelivery/resume never resets a retry cycle. */
  async retry(actor: ImportActor, sessionId: string): Promise<ImportSession> {
    return this.repository.transaction(async (tx) => {
      const session = await this.repository.lock(tx, actor.tenantId, sessionId);
      await this.assertSessionAccess(tx, actor, session);
      const checkpoint = parseCheckpoint(session.checkpoint);
      if (session.incompleteReason === "session_row_limit") return this.summary(tx, session);
      if (checkpoint.enqueuePending || checkpoint.state === "started")
        return this.summary(tx, session);
      const recoverable = checkpoint.failures.filter((f) => f.retryable);
      if (checkpoint.state !== "blocked" && checkpoint.state !== "failed" && !recoverable.length)
        return this.summary(tx, session);
      const work = [...checkpoint.work, ...recoverable.map((f) => f.work)];
      if (!work.length) return this.summary(tx, session);
      const next = newStep({
        ...checkpoint,
        work,
        phase: checkpoint.phase === "done" ? "catch_up" : checkpoint.phase,
        failures: checkpoint.failures.filter((f) => !f.retryable),
      });
      return this.summary(
        tx,
        await this.repository.save(tx, session, {
          actorId: actor.userId,
          state: "queued",
          checkpoint: next,
          incompleteReason: next.failures[0]?.reason ?? null,
          complete: false,
        }),
      );
    });
  }
  /** Jobs must carry expectedStepId from the durable checkpoint. Two-argument calls
   * intentionally process the current step; stale durable deliveries are no-ops. */
  async resume(tenantId: string, sessionId: string, expectedStepId?: string): Promise<void> {
    const claimed = await this.repository.transaction(async (tx) => {
      const session = await this.expire(tx, await this.repository.lock(tx, tenantId, sessionId));
      if (session.state === "cancelled" || session.state === "expired") return null;
      const checkpoint = parseCheckpoint(session.checkpoint);
      if (expectedStepId && checkpoint.stepId !== expectedStepId) return null;
      if (
        !checkpoint.work.length ||
        checkpoint.state === "blocked" ||
        checkpoint.state === "failed" ||
        checkpoint.state === "done"
      )
        return null;
      if (checkpoint.nextRetryAt && Date.parse(checkpoint.nextRetryAt) > Date.now()) return null;
      if (!(await this.authorizeBackground(tx, session, checkpoint))) return null;
      if (checkpoint.attempts >= 4) {
        await this.fail(tx, session, checkpoint, "attempts_exhausted", true);
        return null;
      }
      return { session, checkpoint };
    });
    if (!claimed) return;
    const { session, checkpoint } = claimed;
    const work = checkpoint.work[0];
    if (!work) return;
    const runId = randomUUID();
    let admitted = false;
    let result: NationalCatalogListResult | NationalCatalogResult<NationalCatalogProductsResponse>;
    try {
      result = await this.coordinator.run(
        { tenantId, environment: session.environment },
        async ({ auth, ...options }) => {
          const permitted = await this.repository.transaction(async (tx) => {
            const current = await this.expire(
              tx,
              await this.repository.lock(tx, tenantId, sessionId),
            );
            const cp = parseCheckpoint(current.checkpoint);
            if (
              current.state === "cancelled" ||
              current.state === "expired" ||
              cp.stepId !== checkpoint.stepId ||
              cp.attempts !== checkpoint.attempts
            )
              throw new CatalogRequestError("deferred", "step_changed");
            if (!(await this.authorizeBackground(tx, current, cp))) return false;
            await this.repository.save(tx, current, {
              state: "loading",
              checkpoint: {
                ...cp,
                runId,
                attempts: cp.attempts + 1,
                state: "started",
                nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
                enqueuePending: true,
              },
            });
            return true;
          });
          if (!permitted) throw new CatalogRequestError("blocked", "access_changed");
          admitted = true;
          options.signal.throwIfAborted();
          return work.kind === "list"
            ? this.client.listOwnProducts(
                auth,
                {
                  updatedFrom: formatCatalogDate(work.from),
                  updatedTo: formatCatalogDate(work.to),
                  offset: work.offset,
                  limit: Math.min(1000, 10_000 - work.offset),
                },
                options,
              )
            : this.client.getFeedProducts(auth, work.gtins, options);
        },
        { attempt: checkpoint.attempts },
      );
    } catch (error) {
      if (error instanceof CatalogRequestError) {
        await this.recordError(session, checkpoint, runId, admitted, error);
        return;
      }
      // Unexpected persistence failure retains the admitted marker and retry horizon.
      throw error;
    }
    await this.repository.transaction(async (tx) => {
      const current = await this.expire(tx, await this.repository.lock(tx, tenantId, sessionId));
      const cp = parseCheckpoint(current.checkpoint);
      if (
        current.state === "cancelled" ||
        current.state === "expired" ||
        cp.stepId !== checkpoint.stepId ||
        cp.runId !== runId
      )
        return;
      if (!(await this.authorizeBackground(tx, current, cp))) return;
      await this.accept(tx, current, cp, work, result);
    });
  }
  private async accept(
    tx: DbTx,
    session: ImportSessionRow,
    cp: ImportCheckpoint,
    work: CatalogWork,
    result: NationalCatalogListResult | NationalCatalogResult<NationalCatalogProductsResponse>,
  ): Promise<void> {
    if (result.status === "selection_too_large" && work.kind === "list") {
      const split = splitCatalogInterval(work.from, work.to);
      if (!split) {
        await this.fail(tx, session, cp, "unsplittable_interval", false);
        return;
      }
      await this.advance(tx, session, {
        ...cp,
        work: [
          ...split.map(([from, to]) => ({
            kind: "list" as const,
            from,
            to,
            offset: 0,
            hashes: [],
          })),
          ...cp.work.slice(1),
        ],
      });
      return;
    }
    let incoming: ImportItemWrite[];
    if (result.status !== "ok") {
      if (work.kind === "gtins" && result.status === "not_found")
        incoming = work.gtins.map((gtin) => missingItem(gtin, "not_found"));
      else {
        await this.fail(tx, session, cp, result.status, false);
        return;
      }
    } else if (work.kind === "list" && "rows" in result.value) {
      const page = result.value;
      const hash = pageHash(page.rows);
      if (cp.work[0]?.kind !== "list") return;
      if (work.hashes.includes(hash)) {
        await this.fail(tx, session, cp, "repeated_page", false);
        return;
      }
      if (
        page.nextOffset !== null &&
        (page.nextOffset <= work.offset ||
          page.nextOffset >= 10_000 ||
          !Number.isInteger(page.nextOffset))
      ) {
        await this.fail(tx, session, cp, "invalid_provider_cursor", false);
        return;
      }
      if (page.rows.length > 1000) {
        await this.fail(tx, session, cp, "invalid_page_size", false);
        return;
      }
      incoming = listItems(page.rows);
      cp = {
        ...cp,
        work:
          page.nextOffset === null
            ? cp.work.slice(1)
            : [
                { ...work, offset: page.nextOffset, hashes: [...work.hashes, hash] },
                ...cp.work.slice(1),
              ],
      };
    } else if (work.kind === "gtins" && "products" in result.value) {
      incoming = feedItems(result.value.products, work.gtins);
      cp = { ...cp, work: cp.work.slice(1) };
    } else {
      await this.fail(tx, session, cp, "invalid_response", false);
      return;
    }
    if (result.status === "not_found") cp = { ...cp, work: cp.work.slice(1) };
    let counts: { loaded: number; selected: number };
    try {
      counts = await this.repository.upsert(tx, session, incoming);
    } catch (error) {
      if (error instanceof UnprocessableEntityException && error.message === "session_row_limit") {
        await this.fail(
          tx,
          session,
          parseCheckpoint(session.checkpoint),
          "session_row_limit",
          false,
          true,
        );
        return;
      }
      throw error;
    }
    await this.advance(tx, { ...session, ...counts }, cp, counts);
  }
  private async advance(
    tx: DbTx,
    session: ImportSessionRow,
    cp: ImportCheckpoint,
    counts: Partial<ImportSessionRow> = {},
  ): Promise<void> {
    let throughAt = session.throughAt;
    let catchUpBoundary = session.catchUpBoundary;
    if (!cp.work.length && session.mode === "own_catalog" && cp.phase === "primary") {
      throughAt = new Date(Math.floor(Date.now() / 1000) * 1000);
      catchUpBoundary = throughAt;
      cp = {
        ...cp,
        phase: "catch_up",
        work: [
          {
            kind: "list",
            from: Math.floor(session.startedAt.getTime() / 1000) * 1000 - 1000,
            to: throughAt.getTime(),
            offset: 0,
            hashes: [],
          },
        ],
      };
    }
    const done = !cp.work.length;
    const next = done
      ? {
          ...cp,
          phase: "done" as const,
          state: "done" as const,
          runId: null,
          nextRetryAt: null,
          enqueuePending: false,
        }
      : newStep(cp);
    await this.repository.save(tx, session, {
      ...counts,
      throughAt,
      catchUpBoundary,
      checkpoint: next,
      complete: done && !cp.failures.length,
      state: cp.failures.length ? "partial" : done ? "ready" : "queued",
      incompleteReason: cp.failures[0]?.reason ?? null,
    });
  }
  private async fail(
    tx: DbTx,
    session: ImportSessionRow,
    cp: ImportCheckpoint,
    reason: string,
    retryable: boolean,
    stop = false,
  ): Promise<void> {
    const work = cp.work[0];
    if (!work) return;
    if (stop) {
      await this.stopWork(tx, session, cp, reason, false);
      return;
    }
    if (work.kind === "gtins") {
      let counts: { loaded: number; selected: number };
      try {
        counts = await this.repository.upsert(
          tx,
          session,
          work.gtins.map((gtin) => missingItem(gtin, reason)),
        );
      } catch (error) {
        if (
          error instanceof UnprocessableEntityException &&
          error.message === "session_row_limit"
        ) {
          await this.stopWork(tx, session, cp, "session_row_limit", false);
          return;
        }
        throw error;
      }
      await this.advance(
        tx,
        { ...session, ...counts },
        { ...cp, work: cp.work.slice(1), failures: [...cp.failures, { work, reason, retryable }] },
        counts,
      );
      return;
    }
    if (!retryable) {
      await this.advance(tx, session, {
        ...cp,
        work: cp.work.slice(1),
        failures: [...cp.failures, { work, reason, retryable }],
      });
      return;
    }
    await this.stopWork(tx, session, cp, reason, retryable);
  }
  /** Terminal/error markers never allocate item rows, including a full GTIN session. */
  private async stopWork(
    tx: DbTx,
    session: ImportSessionRow,
    cp: ImportCheckpoint,
    reason: string,
    retryable: boolean,
  ): Promise<void> {
    const work = cp.work[0];
    if (!work) return;
    // Retain every sibling for diagnosis/recovery; capacity exhaustion cannot be retried.
    await this.repository.save(tx, session, {
      state: "partial",
      complete: false,
      incompleteReason: reason,
      checkpoint: {
        ...cp,
        state: "failed",
        enqueuePending: false,
        nextRetryAt: null,
        failures: [...cp.failures, { work, reason, retryable }],
        work: cp.work.slice(1),
      },
    });
  }
  private async recordError(
    session: ImportSessionRow,
    original: ImportCheckpoint,
    runId: string,
    admitted: boolean,
    error: CatalogRequestError,
  ): Promise<void> {
    await this.repository.transaction(async (tx) => {
      const current = await this.expire(
        tx,
        await this.repository.lock(tx, session.tenantId, session.id),
      );
      const cp = parseCheckpoint(current.checkpoint);
      if (
        current.state === "cancelled" ||
        current.state === "expired" ||
        cp.stepId !== original.stepId ||
        (admitted && cp.runId !== runId) ||
        (!admitted && cp.attempts !== original.attempts) ||
        error.reason === "step_changed" ||
        error.reason === "access_changed"
      )
        return;
      if (!(await this.authorizeBackground(tx, current, cp))) return;
      if (
        error.state === "failed" ||
        (error.reason === "forbidden" && cp.work[0]?.kind === "gtins")
      ) {
        await this.fail(tx, current, cp, error.reason, true);
        return;
      }
      await this.repository.save(tx, current, {
        state: error.state === "blocked" ? "blocked" : "partial",
        incompleteReason: error.reason,
        checkpoint: {
          ...cp,
          state: error.state === "blocked" ? "blocked" : "deferred",
          nextRetryAt: error.nextRetryAt?.toISOString() ?? (admitted ? cp.nextRetryAt : null),
          enqueuePending: error.state !== "blocked",
        },
      });
    });
  }
  private async summary(tx: DbTx, row: ImportSessionRow): Promise<ImportSession> {
    return {
      ...dto(row),
      selectedItemIds: await this.repository.selectedIds(tx, row.tenantId, row.id),
    };
  }
  /** Internal consumer API. Caller must have acquired this session via repository.lock
   * in the SAME transaction before checking access and reading/writing its items. */
  async assertSessionAccess(
    tx: DbTx,
    actor: ImportActor,
    lockedSession: ImportSessionRow,
  ): Promise<void> {
    if (lockedSession.tenantId !== actor.tenantId)
      throw new ForbiddenException("session_tenant_mismatch");
    this.active(lockedSession);
    await this.authorize(tx, actor, lockedSession.mode, lockedSession.environment);
  }
  private active(session: ImportSessionRow): void {
    if (
      session.state === "cancelled" ||
      session.state === "expired" ||
      session.expiresAt.getTime() <= Date.now()
    )
      throw new GoneException("import_session_closed");
  }
  private async expire(tx: DbTx, session: ImportSessionRow): Promise<ImportSessionRow> {
    if (
      session.state !== "expired" &&
      session.state !== "cancelled" &&
      session.expiresAt.getTime() <= Date.now()
    )
      return this.repository.save(tx, session, {
        state: "expired",
        checkpoint: { ...parseCheckpoint(session.checkpoint), enqueuePending: false },
      });
    return session;
  }
  private async authorize(
    tx: DbTx,
    actor: ImportActor,
    mode: ImportStart["mode"],
    expected?: ImportSessionRow["environment"],
  ): Promise<ImportSessionRow["environment"]> {
    if (!(mode === "own_catalog" ? this.features.ownCatalog : this.features.gtinLookup))
      throw new ForbiddenException("import_disabled");
    const principal = await this.authorization.resolvePrincipal(actor.userId, actor.tenantId, tx);
    if (!principal?.capabilities.includes(CABINET_CAPABILITY.OPERATIONS_WRITE))
      throw new ForbiddenException("permission_denied");
    await this.entitlements.assertWriteAccess(actor.tenantId, tx);
    const [channel] = await tx
      .select({ settings: schema.integrationChannels.settings })
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, actor.tenantId),
          eq(schema.integrationChannels.type, "chestny_znak"),
        ),
      )
      .for("share");
    const parsed = chzSignerSettingsSchema.safeParse(channel?.settings);
    if (!parsed.success) throw new ForbiddenException("integration_unconfigured");
    if (expected && parsed.data.environment !== expected)
      throw new ForbiddenException("environment_mismatch");
    return parsed.data.environment;
  }
  private async authorizeBackground(
    tx: DbTx,
    session: ImportSessionRow,
    cp: ImportCheckpoint,
  ): Promise<boolean> {
    try {
      await this.authorize(
        tx,
        { tenantId: session.tenantId, userId: session.actorId },
        session.mode,
        session.environment,
      );
      return true;
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      const response = error.getResponse();
      const reason =
        typeof response === "object" && "code" in response && typeof response.code === "string"
          ? response.code
          : error.message;
      await this.repository.save(tx, session, {
        state: "blocked",
        incompleteReason: reason,
        checkpoint: { ...cp, state: "blocked", enqueuePending: false },
      });
      return false;
    }
  }
}
function dto(row: ImportSessionRow): Omit<ImportSession, "selectedItemIds"> {
  return {
    id: row.id,
    revision: row.revision,
    mode: row.mode,
    state: row.state,
    loaded: row.loaded,
    selected: row.selected,
    startedAt: row.startedAt.toISOString(),
    throughAt: row.throughAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    complete: row.complete,
    reason: row.incompleteReason,
  };
}
function itemDto(row: ImportItemRow): ImportItem {
  return {
    id: row.id,
    gtin14: row.gtin14,
    input: row.input,
    cardId: row.cardId,
    name: row.name,
    brand: row.brand,
    statusKeys: row.statusKeys,
    selected: row.selected,
    match: row.match,
    productId: row.productId,
    selectable: row.selectable,
    reason: row.reason,
  };
}
