import { randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { schema } from "@markiro/db";
import {
  importPrepareSchema,
  importPreviewSchema,
  type ImportField,
  type ImportPrepare,
  type ImportPreparation,
  type ImportPrepareResponse,
} from "@markiro/platform-contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { NationalCatalogImportRepository } from "./national-catalog-import.repository";
import type { NationalCatalogImportService } from "./national-catalog-import.service";
import {
  type NationalCatalogRequestCoordinator,
  CatalogRequestError,
} from "./national-catalog-request-coordinator";
import type { NationalCatalogClient } from "./national-catalog.client";
import type {
  DbTx,
  ImportActor,
  ImportItemRow,
  ImportSessionRow,
} from "./national-catalog-import.types";
import {
  buildImportPreview,
  resolveCategoryOption,
} from "./national-catalog-import-preview-builder";
import {
  canonicalPreparation,
  preparationCheckpoint,
  parsePreparationCheckpoint,
  preparationStep,
  chunks,
  type PreparationCheckpoint,
} from "./national-catalog-preparation-state";
import type {
  NationalCatalogProductsResponse,
  NationalCatalogResult,
} from "./national-catalog.types";

export function defaultAcceptedEntries(mode: "new" | "existing", fields: ImportField[]): string[] {
  return mode === "existing"
    ? []
    : fields.filter((field) => field.applicable).map((field) => field.id);
}
const preparations = schema.nationalCatalogImportPreparations;
const previews = schema.nationalCatalogImportPreviews;
const items = schema.nationalCatalogImportItems;
type PreparationRow = typeof preparations.$inferSelect;
const scope = (tenantId: string, sessionId: string, id: string) =>
  and(
    eq(preparations.tenantId, tenantId),
    eq(preparations.sessionId, sessionId),
    eq(preparations.id, id),
  );
/** HTTP only records intent. GET never calls a provider; jobs process one bounded step. */
export class NationalCatalogImportPreviewService {
  constructor(
    private readonly repository: NationalCatalogImportRepository,
    private readonly sessions: NationalCatalogImportService,
    private readonly client: Pick<NationalCatalogClient, "getFeedProductsByIds">,
    private readonly coordinator: NationalCatalogRequestCoordinator,
  ) {}
  async prepare(
    actor: ImportActor,
    sessionId: string,
    input: ImportPrepare,
  ): Promise<ImportPrepareResponse> {
    const { body, hash } = canonicalPreparation(input);
    return this.repository.transaction(async (tx) => {
      const session = await this.repository.lock(tx, actor.tenantId, sessionId);
      await this.sessions.assertSessionAccess(tx, actor, session);
      const [existing] = await tx
        .select()
        .from(preparations)
        .where(
          and(
            eq(preparations.tenantId, actor.tenantId),
            eq(preparations.sessionId, sessionId),
            eq(preparations.requestId, body.requestId),
          ),
        );
      if (existing) {
        if (existing.requestHash !== hash)
          throw new ConflictException("preparation_request_reused");
        return this.response(tx, existing);
      }
      await this.selectedItems(tx, actor.tenantId, sessionId, body.itemIds);
      for (const choice of body.categoryChoices)
        await resolveCategoryOption(tx, actor.tenantId, sessionId, choice.itemId, choice.optionId);
      const [row] = await tx
        .insert(preparations)
        .values({
          tenantId: actor.tenantId,
          sessionId,
          actorId: actor.userId,
          requestId: body.requestId,
          requestHash: hash,
          request: body,
          checkpoint: preparationCheckpoint(body.itemIds),
          expiresAt: session.expiresAt,
        })
        .returning();
      if (!row) throw new Error("Preparation insert returned no row");
      return this.response(tx, row);
    });
  }
  /** Stored read only. Task11 HTTP guards enforce current tenant READ access;
   * rollout, WRITE entitlement and provider configuration do not gate retained data. */
  async readPreparation(
    tenantId: string,
    sessionId: string,
    preparationId: string,
  ): Promise<ImportPrepareResponse> {
    return this.repository.transaction(async (tx) => {
      const session = await this.repository.lock(tx, tenantId, sessionId);
      const preparation = await this.lock(tx, tenantId, sessionId, preparationId);
      if (
        session.state === "cancelled" ||
        session.state === "expired" ||
        session.expiresAt.getTime() <= Date.now() ||
        preparation.expiresAt.getTime() <= Date.now()
      )
        throw new GoneException("import_preparation_closed");
      return this.response(tx, preparation);
    });
  }
  async retryPreparation(
    actor: ImportActor,
    sessionId: string,
    preparationId: string,
  ): Promise<ImportPrepareResponse> {
    return this.repository.transaction(async (tx) => {
      const session = await this.repository.lock(tx, actor.tenantId, sessionId);
      await this.sessions.assertSessionAccess(tx, actor, session);
      const row = await this.lock(tx, actor.tenantId, sessionId, preparationId);
      const cp = parsePreparationCheckpoint(row.checkpoint);
      // A repeated retry while queued/started/deferred must not create an unbounded cycle.
      if (cp.enqueuePending) return this.response(tx, row);
      const retryIds = cp.failures.filter((f) => f.retryable).map((f) => f.itemId);
      if (!retryIds.length && cp.state !== "blocked") return this.response(tx, row);
      const next = preparationStep({
        ...cp,
        work: [...cp.work, ...chunks(retryIds)],
        failures: cp.failures.filter((f) => !f.retryable),
      });
      await this.selectedItems(tx, actor.tenantId, sessionId, next.work.flat());
      const saved = await this.save(tx, row, next, actor.userId);
      return this.response(tx, saved);
    });
  }
  /** Repair supplies durable stepId; stale delivery cannot repeat a completed batch. */
  async resumePreparation(
    tenantId: string,
    sessionId: string,
    preparationId: string,
    expectedStepId?: string,
  ): Promise<void> {
    const claim = await this.repository.transaction(async (tx) => {
      const session = await this.repository.lock(tx, tenantId, sessionId);
      const row = await this.lock(tx, tenantId, sessionId, preparationId);
      const cp = parsePreparationCheckpoint(row.checkpoint);
      if (expectedStepId && expectedStepId !== cp.stepId) return null;
      if (
        !cp.enqueuePending ||
        !cp.work.length ||
        (cp.nextRetryAt && Date.parse(cp.nextRetryAt) > Date.now())
      )
        return null;
      if (!(await this.authorize(tx, session, row, cp))) return null;
      if (cp.attempts >= 4) {
        await this.failBatch(tx, row, cp, "attempts_exhausted", true);
        return null;
      }
      let selected: ImportItemRow[];
      try {
        selected = await this.selectedItems(tx, tenantId, sessionId, cp.work[0] ?? []);
      } catch (error) {
        if (!(error instanceof UnprocessableEntityException)) throw error;
        await this.failBatch(tx, row, cp, "selection_changed", false);
        return null;
      }
      return { session, row, cp, selected };
    });
    if (!claim) return;
    const { session, cp, selected } = claim;
    const runId = randomUUID();
    let admitted = false;
    let result: NationalCatalogResult<NationalCatalogProductsResponse>;
    try {
      result = await this.coordinator.run(
        { tenantId, environment: session.environment },
        async ({ auth, ...options }) => {
          const allowed = await this.repository.transaction(async (tx) => {
            const currentSession = await this.repository.lock(tx, tenantId, sessionId);
            const current = await this.lock(tx, tenantId, sessionId, preparationId);
            const checkpoint = parsePreparationCheckpoint(current.checkpoint);
            if (
              checkpoint.stepId !== cp.stepId ||
              checkpoint.attempts !== cp.attempts ||
              !checkpoint.enqueuePending
            )
              throw new CatalogRequestError("deferred", "step_changed");
            if (!(await this.authorize(tx, currentSession, current, checkpoint))) return false;
            await this.save(tx, current, {
              ...checkpoint,
              runId,
              attempts: checkpoint.attempts + 1,
              state: "started",
              nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
              enqueuePending: true,
            });
            return true;
          });
          if (!allowed) throw new CatalogRequestError("blocked", "access_changed");
          admitted = true;
          options.signal.throwIfAborted();
          return this.client.getFeedProductsByIds(
            auth,
            [...new Set(selected.flatMap((item) => (item.cardId ? [item.cardId] : [])))],
            options,
          );
        },
        { attempt: cp.attempts },
      );
    } catch (error) {
      if (!(error instanceof CatalogRequestError)) throw error;
      await this.repository.transaction(async (tx) => {
        const currentSession = await this.repository.lock(tx, tenantId, sessionId);
        const current = await this.lock(tx, tenantId, sessionId, preparationId);
        const checkpoint = parsePreparationCheckpoint(current.checkpoint);
        if (
          checkpoint.stepId !== cp.stepId ||
          (admitted ? checkpoint.runId !== runId : checkpoint.attempts !== cp.attempts) ||
          !checkpoint.enqueuePending ||
          error.reason === "step_changed" ||
          error.reason === "access_changed"
        )
          return;
        if (!(await this.authorize(tx, currentSession, current, checkpoint))) return;
        if (error.state === "failed") {
          await this.failBatch(tx, current, checkpoint, error.reason, true);
          return;
        }
        await this.save(tx, current, {
          ...checkpoint,
          state: error.state === "blocked" ? "blocked" : "deferred",
          reason: error.reason,
          nextRetryAt: error.nextRetryAt?.toISOString() ?? checkpoint.nextRetryAt,
          enqueuePending: error.state !== "blocked",
        });
      });
      return;
    }
    await this.repository.transaction(async (tx) => {
      const currentSession = await this.repository.lock(tx, tenantId, sessionId);
      const current = await this.lock(tx, tenantId, sessionId, preparationId);
      const checkpoint = parsePreparationCheckpoint(current.checkpoint);
      if (
        checkpoint.stepId !== cp.stepId ||
        checkpoint.runId !== runId ||
        !checkpoint.enqueuePending
      )
        return;
      if (!(await this.authorize(tx, currentSession, current, checkpoint))) return;
      if (result.status !== "ok") {
        await this.failBatch(tx, current, checkpoint, result.status, false);
        return;
      }
      const request = importPrepareSchema.parse(current.request);
      const completed = [...checkpoint.completed];
      const failures = [...checkpoint.failures];
      for (const original of selected) {
        let failure: string | null = null;
        const [item] = await tx
          .select()
          .from(items)
          .where(
            and(
              eq(items.tenantId, tenantId),
              eq(items.sessionId, sessionId),
              eq(items.id, original.id),
            ),
          );
        const cards = result.value.products.filter(
          (product) => String(product.id) === original.cardId,
        );
        if (
          !item ||
          !item.selected ||
          !item.selectable ||
          item.cardId !== original.cardId ||
          item.gtin14 !== original.gtin14
        )
          failure = "selection_changed";
        else if (cards.length !== 1) failure = cards.length ? "ambiguous_card" : "not_found";
        else {
          const card = cards[0];
          if (!card) throw new Error("Missing matched card");
          try {
            const preview = await buildImportPreview(tx, currentSession, item, card, request);
            completed.push({ itemId: item.id, previewId: preview.id });
          } catch (error) {
            if (!(
              error instanceof ConflictException || error instanceof UnprocessableEntityException
            ))
              throw error;
            failure = error.message;
          }
        }
        if (failure) failures.push({ itemId: original.id, reason: failure, retryable: false });
      }
      await this.save(
        tx,
        current,
        preparationStep({ ...checkpoint, work: checkpoint.work.slice(1), completed, failures }),
      );
    });
  }
  private async selectedItems(
    tx: DbTx,
    tenantId: string,
    sessionId: string,
    ids: string[],
  ): Promise<ImportItemRow[]> {
    if (!ids.length) return [];
    const rows = await tx
      .select()
      .from(items)
      .where(
        and(eq(items.tenantId, tenantId), eq(items.sessionId, sessionId), inArray(items.id, ids)),
      );
    if (
      rows.length !== ids.length ||
      rows.some(
        (row) =>
          !row.selected ||
          !row.selectable ||
          !row.gtin14 ||
          !row.cardId ||
          !row.sourceHash ||
          row.statusKeys.includes("archived"),
      )
    )
      throw new UnprocessableEntityException("selection_invalid");
    const cardsByGtin = new Map<string, string>();
    for (const row of rows) {
      if (row.gtin14 && row.cardId) {
        const previous = cardsByGtin.get(row.gtin14);
        if (previous && previous !== row.cardId)
          throw new UnprocessableEntityException("competing_cards");
        cardsByGtin.set(row.gtin14, row.cardId);
      }
    }
    return rows;
  }
  private async authorize(
    tx: DbTx,
    session: ImportSessionRow,
    row: PreparationRow,
    cp: PreparationCheckpoint,
  ): Promise<boolean> {
    try {
      await this.sessions.assertSessionAccess(
        tx,
        { tenantId: row.tenantId, userId: row.actorId },
        session,
      );
      return true;
    } catch (error) {
      if (!(error instanceof ForbiddenException || error instanceof GoneException)) throw error;
      const response = error.getResponse();
      const reason =
        typeof response === "object" && "code" in response && typeof response.code === "string"
          ? response.code
          : error.message;
      await this.save(tx, row, {
        ...cp,
        state: "blocked",
        enqueuePending: false,
        nextRetryAt: null,
        reason,
      });
      return false;
    }
  }
  private async failBatch(
    tx: DbTx,
    row: PreparationRow,
    cp: PreparationCheckpoint,
    reason: string,
    retryable: boolean,
  ): Promise<void> {
    await this.save(
      tx,
      row,
      preparationStep({
        ...cp,
        work: cp.work.slice(1),
        failures: [
          ...cp.failures,
          ...(cp.work[0] ?? []).map((itemId) => ({ itemId, reason, retryable })),
        ],
      }),
    );
  }
  private async lock(
    tx: DbTx,
    tenantId: string,
    sessionId: string,
    id: string,
  ): Promise<PreparationRow> {
    const [row] = await tx
      .select()
      .from(preparations)
      .where(scope(tenantId, sessionId, id))
      .for("update");
    if (!row) throw new NotFoundException("preparation_not_found");
    return row;
  }
  private async save(
    tx: DbTx,
    row: PreparationRow,
    checkpoint: PreparationCheckpoint,
    actorId = row.actorId,
  ): Promise<PreparationRow> {
    const [saved] = await tx
      .update(preparations)
      .set({ checkpoint, actorId, updatedAt: new Date() })
      .where(scope(row.tenantId, row.sessionId, row.id))
      .returning();
    if (!saved) throw new NotFoundException("preparation_not_found");
    return saved;
  }
  private async response(tx: DbTx, row: PreparationRow): Promise<ImportPrepareResponse> {
    const cp = parsePreparationCheckpoint(row.checkpoint);
    const body = importPrepareSchema.parse(row.request);
    const ids = cp.completed.map((item) => item.previewId);
    const stored = ids.length
      ? await tx
          .select({ id: previews.id, diff: previews.diff })
          .from(previews)
          .where(
            and(
              eq(previews.tenantId, row.tenantId),
              eq(previews.sessionId, row.sessionId),
              inArray(previews.id, ids),
            ),
          )
      : [];
    const mapped = new Map(
      stored.map((preview) => {
        const diff = preview.diff;
        if (!diff || typeof diff !== "object" || !("view" in diff))
          throw new ConflictException("preview_unavailable");
        return [preview.id, importPreviewSchema.parse(diff.view)] as const;
      }),
    );
    const views = ids.map((id) => {
      const view = mapped.get(id);
      if (!view) throw new ConflictException("preview_unavailable");
      return view;
    });
    const state: ImportPreparation["state"] =
      cp.state === "blocked"
        ? "blocked"
        : cp.state === "done"
          ? cp.failures.length
            ? cp.completed.length
              ? "partial"
              : "failed"
            : "ready"
          : cp.state === "started"
            ? "loading"
            : cp.failures.length || cp.state === "deferred"
              ? "partial"
              : "queued";
    return {
      preparation: {
        id: row.id,
        requestId: row.requestId,
        state,
        total: body.itemIds.length,
        completed: cp.completed.length,
        failures: cp.failures,
        nextRetryAt: cp.nextRetryAt,
        reason: cp.reason,
        expiresAt: row.expiresAt.toISOString(),
      },
      items: views,
    };
  }
}
