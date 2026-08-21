import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, gte, ilike, inArray, isNull, or, sql, sum } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { formatSsccWithAi, parseScannedSscc } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { upperBoundCondition } from "../../lib/date-range";
import { lockTenantBoxRegistry } from "../boxes/box-registry-lock";
import { advanceBoxRegistryVersion } from "../boxes/box-registry-version";
import { nextDocNo } from "./doc-number";
import type {
  CreateDocumentDto,
  DocumentDetailDto,
  DocumentDto,
  LineDto,
  ListDocumentsQueryDto,
  UpdateDocumentDto,
} from "./dto";
import { validateBoxCandidates } from "./line-validation";
import type { DisaggregationReportCode, DisaggregationReportData } from "./report";

const PAGE_SIZE = 50;

@Injectable()
export class DisaggregationService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async createDocument(
    tenantId: string,
    userId: string,
    data: CreateDocumentDto,
  ): Promise<DocumentDto> {
    return this.db.transaction(async (tx) => {
      if (data.reasonId) await this.assertReasonExists(tx, tenantId, data.reasonId);
      const docNo = await nextDocNo(
        { execute: (q) => tx.execute<{ seq: number }>(q as Parameters<typeof tx.execute>[0]) },
        tenantId,
        new Date(),
      );
      const [row] = await tx
        .insert(schema.disaggregationDocuments)
        .values({
          tenantId,
          docNo,
          reasonId: data.reasonId ?? null,
          comment: data.comment ?? null,
          createdByUserId: userId,
        })
        .returning();
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId: userId,
        action: "disaggregation.document.created",
        outcome: "success",
        targetType: "disaggregation_document",
        targetId: row!.id,
      });
      return this.toDocumentDto(tenantId, row!);
    });
  }

  async listDocuments(tenantId: string, query: ListDocumentsQueryDto) {
    // Same date-only `to` treatment as code-search's listCodes: the admin
    // sends `YYYY-MM-DD`, which a plain `lte` would cut off at midnight UTC
    // instead of the end of that day.
    const toCondition = upperBoundCondition(schema.disaggregationDocuments.createdAt, query.to);
    const where = and(
      eq(schema.disaggregationDocuments.tenantId, tenantId),
      query.status ? eq(schema.disaggregationDocuments.status, query.status) : undefined,
      query.reasonId ? eq(schema.disaggregationDocuments.reasonId, query.reasonId) : undefined,
      query.from ? gte(schema.disaggregationDocuments.createdAt, query.from) : undefined,
      toCondition,
      query.docNo ? ilike(schema.disaggregationDocuments.docNo, `%${query.docNo}%`) : undefined,
    );
    const [totalRow] = await this.db
      .select({ total: count() })
      .from(schema.disaggregationDocuments)
      .where(where);
    const total = totalRow?.total ?? 0;
    const rows = await this.db
      .select()
      .from(schema.disaggregationDocuments)
      .where(where)
      .orderBy(desc(schema.disaggregationDocuments.createdAt))
      .limit(PAGE_SIZE)
      .offset((query.page - 1) * PAGE_SIZE);
    const items = await this.toDocumentDtos(tenantId, rows);
    return {
      items,
      page: query.page,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      total,
    };
  }

  async getDocument(tenantId: string, id: string): Promise<DocumentDetailDto> {
    const row = await this.findDocument(tenantId, id);
    const lines = await this.listLines(tenantId, id);
    return { ...(await this.toDocumentDto(tenantId, row)), lines };
  }

  async updateDocument(
    tenantId: string,
    id: string,
    data: UpdateDocumentDto,
  ): Promise<DocumentDto> {
    // findDocument still runs first so a missing document 404s (distinct
    // from "not a draft anymore"); the actual guard against a concurrent
    // apply is the `status = 'draft'` condition on the UPDATE's WHERE
    // itself -- same TOCTOU shape `cancelDocument` already closes.
    await this.findDocument(tenantId, id);
    if (data.reasonId) await this.assertReasonExists(this.db, tenantId, data.reasonId);
    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    if (data.reasonId !== undefined) set.reasonId = data.reasonId;
    if (data.comment !== undefined) set.comment = data.comment;
    const [updated] = await this.db
      .update(schema.disaggregationDocuments)
      .set(set)
      .where(
        and(
          eq(schema.disaggregationDocuments.tenantId, tenantId),
          eq(schema.disaggregationDocuments.id, id),
          eq(schema.disaggregationDocuments.status, "draft"),
        ),
      )
      .returning();
    if (!updated)
      throw new ConflictException({ code: "not_draft", message: "Document is not a draft" });
    return this.toDocumentDto(tenantId, updated);
  }

  async cancelDocument(tenantId: string, id: string, userId: string): Promise<DocumentDto> {
    await this.findDocument(tenantId, id);
    // Re-assert draft in the WHERE itself: a concurrent apply between the
    // read above and this UPDATE would otherwise let this write a
    // "cancelled" status over an "applied" row, tripping
    // disaggregation_documents_applied_fields_check (500) instead of a
    // clean 409.
    const [updated] = await this.db
      .update(schema.disaggregationDocuments)
      .set({ status: "cancelled", cancelledAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.disaggregationDocuments.tenantId, tenantId),
          eq(schema.disaggregationDocuments.id, id),
          eq(schema.disaggregationDocuments.status, "draft"),
        ),
      )
      .returning();
    if (!updated)
      throw new ConflictException({ code: "not_draft", message: "Document is not a draft" });
    await this.db.insert(schema.tenantAuditEvents).values({
      organizationId: tenantId,
      actorUserId: userId,
      action: "disaggregation.document.cancelled",
      outcome: "success",
      targetType: "disaggregation_document",
      targetId: id,
    });
    return this.toDocumentDto(tenantId, updated);
  }

  /**
   * Applies (проводит) a document: re-validates every line under the box
   * registry lock and, only if all lines are still `ok`, disassembles their
   * boxes, releases the boxes' live items, records `disassemble` box
   * exceptions, bumps the registry version once, and marks the document
   * applied -- all in one transaction.
   *
   * IMPORTANT ordering: a `ConflictException` thrown INSIDE `tx` rolls the
   * whole transaction back, including the just-computed fresh line statuses.
   * The invalid-lines case must not lose that revalidation, so this method
   * never throws `invalid_lines` inside the transaction -- it sets `allOk =
   * false`, lets the transaction commit (persisting the fresh statuses, the
   * document still `draft`, no box mutated), and only then throws after
   * commit. Only `reason_required` / `no_lines` / `not_draft` / NotFound may
   * throw inside `tx`, because none of those has anything to persist.
   */
  async applyDocument(
    tenantId: string,
    documentId: string,
    userId: string,
  ): Promise<DocumentDetailDto> {
    let allOk = true;

    await this.db.transaction(async (tx) => {
      // Same lock root every station batch / kiosk mutation takes first.
      await lockTenantBoxRegistry(tx, tenantId);

      const [doc] = await tx
        .select()
        .from(schema.disaggregationDocuments)
        .where(
          and(
            eq(schema.disaggregationDocuments.tenantId, tenantId),
            eq(schema.disaggregationDocuments.id, documentId),
          ),
        )
        .for("update");
      if (!doc) throw new NotFoundException();
      this.assertDraft(doc);
      if (!doc.reasonId) throw new ConflictException({ code: "reason_required" });

      const lines = await tx
        .select()
        .from(schema.disaggregationDocumentLines)
        .where(
          and(
            eq(schema.disaggregationDocumentLines.tenantId, tenantId),
            eq(schema.disaggregationDocumentLines.documentId, documentId),
          ),
        );
      if (lines.length === 0) throw new ConflictException({ code: "no_lines" });

      // Re-validate everything under the lock.
      const ssccs = lines.map((l) => l.sscc).filter((s): s is string => s !== null);
      const candidates = await validateBoxCandidates(tx, tenantId, ssccs);
      for (const line of lines) {
        const fresh =
          line.sscc === null
            ? line.status // not_found / duplicate rows keep their status
            : (candidates.get(line.sscc)?.status ?? "not_found");
        if (fresh !== line.status || line.sscc !== null) {
          await tx
            .update(schema.disaggregationDocumentLines)
            .set({
              status: fresh,
              validatedAt: sql`now()`,
              boxId: line.sscc !== null ? (candidates.get(line.sscc)?.boxId ?? null) : line.boxId,
              codeCount:
                line.sscc !== null ? (candidates.get(line.sscc)?.codeCount ?? 0) : line.codeCount,
            })
            .where(
              and(
                eq(schema.disaggregationDocumentLines.tenantId, tenantId),
                eq(schema.disaggregationDocumentLines.id, line.id),
              ),
            );
        }
        if (fresh !== "ok") allOk = false;
      }
      // Do NOT throw here: let the fresh statuses above commit even when
      // invalid, and only mutate boxes / apply the document when they're
      // all clean.
      if (!allOk) return;

      const [reason] = await tx
        .select({ name: schema.disaggregationReasons.name })
        .from(schema.disaggregationReasons)
        .where(
          and(
            eq(schema.disaggregationReasons.tenantId, tenantId),
            eq(schema.disaggregationReasons.id, doc.reasonId),
          ),
        );
      if (!reason) throw new ConflictException({ code: "reason_required" });
      const reasonText = doc.comment ? `${reason.name}: ${doc.comment}` : reason.name;

      const boxIds = ssccs.map((s) => candidates.get(s)!.boxId);
      const boxRows = await tx
        .select({
          id: schema.boxes.id,
          shiftId: schema.boxes.shiftId,
          terminalId: schema.boxes.terminalId,
        })
        .from(schema.boxes)
        .where(and(eq(schema.boxes.tenantId, tenantId), inArray(schema.boxes.id, boxIds)));

      // Same mechanics as the station's "disassemble" branch
      // (station-scans.service.ts): retire the box, release its live items.
      await tx
        .update(schema.boxes)
        .set({ disassembledAt: sql`now()` })
        .where(and(eq(schema.boxes.tenantId, tenantId), inArray(schema.boxes.id, boxIds)));
      await tx
        .update(schema.boxItems)
        .set({ removedAt: sql`now()` })
        .where(
          and(
            eq(schema.boxItems.tenantId, tenantId),
            inArray(schema.boxItems.boxId, boxIds),
            isNull(schema.boxItems.displacedAt),
            isNull(schema.boxItems.removedAt),
          ),
        );
      await tx.insert(schema.boxExceptions).values(
        boxRows.map((box) => ({
          tenantId,
          kind: "disassemble" as const,
          boxId: box.id,
          shiftId: box.shiftId,
          terminalId: box.terminalId,
          operatorId: null, // admin action; the actor is on the document + audit event
          reason: reasonText.slice(0, 500),
          occurredAt: new Date(),
          disaggregationDocumentId: documentId,
        })),
      );
      await advanceBoxRegistryVersion(tx, tenantId, boxIds);

      await tx
        .update(schema.disaggregationDocuments)
        .set({
          status: "applied",
          appliedAt: sql`now()`,
          appliedByUserId: userId,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.disaggregationDocuments.tenantId, tenantId),
            eq(schema.disaggregationDocuments.id, documentId),
          ),
        );
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId: userId,
        action: "disaggregation.document.applied",
        outcome: "success",
        targetType: "disaggregation_document",
        targetId: documentId,
        after: { boxIds },
      });
    });

    if (!allOk) {
      throw new ConflictException({
        code: "invalid_lines",
        lines: await this.listLines(tenantId, documentId),
      });
    }
    return this.getDocument(tenantId, documentId);
  }

  /**
   * Everything the printed "Акт дезагрегации" needs (see `report.ts`). Only
   * lines with a parseable SSCC make it onto the paper — unparseable input
   * and duplicate markers are screen-only validation artifacts. With
   * `includeContents`, each box's unit codes are resolved through
   * `code_registry` (the winner row) into the partitioned `codes` table on
   * all three PK columns. For a box disassembled BY this document the items
   * were released with `removed_at = boxes.disassembled_at` (both stamped
   * `now()` in the apply transaction), so contents are: live items OR items
   * removed at the disassembly instant.
   */
  async reportData(
    tenantId: string,
    id: string,
    includeContents: boolean,
  ): Promise<DisaggregationReportData> {
    const row = await this.findDocument(tenantId, id);
    const lines = await this.listLines(tenantId, id);
    const printable = lines.filter(
      (line): line is (typeof lines)[number] & { sscc: string } => line.sscc !== null,
    );

    let reasonName: string | null = null;
    if (row.reasonId) {
      const [reason] = await this.db
        .select({ name: schema.disaggregationReasons.name })
        .from(schema.disaggregationReasons)
        .where(
          and(
            eq(schema.disaggregationReasons.tenantId, tenantId),
            eq(schema.disaggregationReasons.id, row.reasonId),
          ),
        );
      reasonName = reason?.name ?? null;
    }

    const userIds = [
      ...new Set([row.createdByUserId, ...(row.appliedByUserId ? [row.appliedByUserId] : [])]),
    ];
    const userRows = await this.db
      .select({ id: schema.user.id, name: schema.user.name })
      .from(schema.user)
      .where(inArray(schema.user.id, userIds));
    const userNameById = new Map(userRows.map((u) => [u.id, u.name]));

    const [org] = await this.db
      .select({
        name: schema.organization.name,
        inn: schema.orgProfiles.inn,
        logo: schema.organization.logo,
      })
      .from(schema.organization)
      .leftJoin(schema.orgProfiles, eq(schema.orgProfiles.tenantId, schema.organization.id))
      .where(eq(schema.organization.id, tenantId));

    const codesByBoxId = new Map<string, DisaggregationReportCode[]>();
    if (includeContents) {
      const boxIds = [
        ...new Set(printable.map((line) => line.boxId).filter((b): b is string => b !== null)),
      ];
      if (boxIds.length > 0) {
        const codeRows = await this.db
          .select({
            boxId: schema.boxItems.boxId,
            gtin14: schema.codes.gtin14,
            serial: schema.codes.serial,
            rawKm: schema.codes.canonicalRaw,
          })
          .from(schema.boxItems)
          .innerJoin(
            schema.boxes,
            and(
              eq(schema.boxes.tenantId, schema.boxItems.tenantId),
              eq(schema.boxes.id, schema.boxItems.boxId),
            ),
          )
          .innerJoin(
            schema.codeRegistry,
            and(
              eq(schema.codeRegistry.tenantId, schema.boxItems.tenantId),
              eq(schema.codeRegistry.codeHash, schema.boxItems.codeHash),
            ),
          )
          .innerJoin(
            schema.codes,
            and(
              eq(schema.codes.tenantId, schema.codeRegistry.tenantId),
              eq(schema.codes.codeHash, schema.codeRegistry.codeHash),
              eq(schema.codes.scannedAt, schema.codeRegistry.scannedAt),
            ),
          )
          .where(
            and(
              eq(schema.boxItems.tenantId, tenantId),
              inArray(schema.boxItems.boxId, boxIds),
              isNull(schema.boxItems.displacedAt),
              or(
                isNull(schema.boxItems.removedAt),
                eq(schema.boxItems.removedAt, schema.boxes.disassembledAt),
              ),
            ),
          )
          .orderBy(schema.codes.gtin14, schema.codes.serial);
        for (const code of codeRows) {
          const bucket = codesByBoxId.get(code.boxId);
          const entry = { gtin14: code.gtin14, serial: code.serial, rawKm: code.rawKm };
          if (bucket) bucket.push(entry);
          else codesByBoxId.set(code.boxId, [entry]);
        }
      }
    }

    return {
      docNo: row.docNo,
      status: row.status,
      createdAt: row.createdAt,
      appliedAt: row.appliedAt,
      org: org ? { name: org.name, inn: org.inn, logo: org.logo } : null,
      createdByName: userNameById.get(row.createdByUserId) ?? null,
      appliedByName: row.appliedByUserId ? (userNameById.get(row.appliedByUserId) ?? null) : null,
      reasonName,
      comment: row.comment,
      includeContents,
      lines: printable.map((line, index) => ({
        n: index + 1,
        sscc: line.sscc,
        productName: line.productName,
        codeCount: line.codeCount,
        codes: line.boxId ? (codesByBoxId.get(line.boxId) ?? []) : [],
      })),
    };
  }

  // ---- shared helpers (Tasks 4-6 reuse these) ----

  async findDocument(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(schema.disaggregationDocuments)
      .where(
        and(
          eq(schema.disaggregationDocuments.tenantId, tenantId),
          eq(schema.disaggregationDocuments.id, id),
        ),
      );
    if (!row) throw new NotFoundException();
    return row;
  }

  assertDraft(row: { status: string }): void {
    if (row.status !== "draft") {
      throw new ConflictException({ code: "not_draft", message: "Document is not a draft" });
    }
  }

  /** Throws `BadRequestException({ code: "unknown_reason" })` unless (tenantId, reasonId) exists. */
  private async assertReasonExists(
    db: Pick<Db, "select">,
    tenantId: string,
    reasonId: string,
  ): Promise<void> {
    const [row] = await db
      .select({ id: schema.disaggregationReasons.id })
      .from(schema.disaggregationReasons)
      .where(
        and(
          eq(schema.disaggregationReasons.tenantId, tenantId),
          eq(schema.disaggregationReasons.id, reasonId),
        ),
      );
    if (!row) throw new BadRequestException({ code: "unknown_reason" });
  }

  async listLines(tenantId: string, documentId: string): Promise<LineDto[]> {
    return this.listLinesTx(this.db, tenantId, documentId);
  }

  /** `listLines`, parameterized on the executor so it can be called with a `tx` mid-transaction (see `addLines`/`removeLine`). */
  private async listLinesTx(
    db: Pick<Db, "select">,
    tenantId: string,
    documentId: string,
  ): Promise<LineDto[]> {
    const rows = await db
      .select({
        id: schema.disaggregationDocumentLines.id,
        ssccInput: schema.disaggregationDocumentLines.ssccInput,
        sscc: schema.disaggregationDocumentLines.sscc,
        boxId: schema.disaggregationDocumentLines.boxId,
        status: schema.disaggregationDocumentLines.status,
        productId: schema.disaggregationDocumentLines.productId,
        productName: schema.products.name,
        codeCount: schema.disaggregationDocumentLines.codeCount,
        validatedAt: schema.disaggregationDocumentLines.validatedAt,
      })
      .from(schema.disaggregationDocumentLines)
      .leftJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.disaggregationDocumentLines.tenantId),
          eq(schema.products.id, schema.disaggregationDocumentLines.productId),
        ),
      )
      .where(
        and(
          eq(schema.disaggregationDocumentLines.tenantId, tenantId),
          eq(schema.disaggregationDocumentLines.documentId, documentId),
        ),
      )
      .orderBy(schema.disaggregationDocumentLines.createdAt, schema.disaggregationDocumentLines.id);
    return rows.map((r) => ({ ...r, sscc: r.sscc === null ? null : formatSsccWithAi(r.sscc) }));
  }

  /**
   * Wrapped in a transaction with the document row `FOR UPDATE`, re-checked
   * `draft` INSIDE the lock: a plain read-then-write (the old shape) leaves
   * a window for a concurrent `applyDocument` to slip in between the read
   * and this write, appending/removing lines on a document that's already
   * applied -- a spec-invariant violation (applied documents are immutable).
   * `FOR UPDATE` here contends with `applyDocument`'s own `FOR UPDATE`
   * select on the same row, so one of the two always loses the race
   * cleanly instead of both proceeding.
   */
  async addLines(tenantId: string, documentId: string, ssccs: string[]) {
    return this.db.transaction(async (tx) => {
      const [doc] = await tx
        .select()
        .from(schema.disaggregationDocuments)
        .where(
          and(
            eq(schema.disaggregationDocuments.tenantId, tenantId),
            eq(schema.disaggregationDocuments.id, documentId),
          ),
        )
        .for("update");
      if (!doc) throw new NotFoundException();
      this.assertDraft(doc);

      // Parse first: normalize every input to bare-18 or null.
      const parsed = ssccs.map((input) => ({
        input,
        sscc: parseScannedSscc(input.trim()),
      }));
      const candidates = await validateBoxCandidates(tx, tenantId, [
        ...new Set(parsed.map((p) => p.sscc).filter((s): s is string => s !== null)),
      ]);

      const existing = new Set(
        (
          await tx
            .select({ sscc: schema.disaggregationDocumentLines.sscc })
            .from(schema.disaggregationDocumentLines)
            .where(
              and(
                eq(schema.disaggregationDocumentLines.tenantId, tenantId),
                eq(schema.disaggregationDocumentLines.documentId, documentId),
              ),
            )
        )
          .map((r) => r.sscc)
          .filter((s): s is string => s !== null),
      );

      const values = [];
      for (const { input, sscc } of parsed) {
        if (sscc === null) {
          values.push({
            tenantId,
            documentId,
            ssccInput: input,
            sscc: null,
            status: "not_found" as const,
          });
          continue;
        }
        if (existing.has(sscc)) {
          // Store nothing for a repeat of an already-present line — repeats in
          // the SAME request get one real row + duplicate marker rows would
          // violate the unique index, so mark duplicates with sscc NULL kept
          // as the raw input for visibility.
          values.push({
            tenantId,
            documentId,
            ssccInput: input,
            sscc: null,
            status: "duplicate" as const,
          });
          continue;
        }
        existing.add(sscc);
        const candidate = candidates.get(sscc);
        values.push({
          tenantId,
          documentId,
          ssccInput: input,
          sscc,
          status: candidate?.status ?? ("not_found" as const),
          boxId: candidate?.boxId ?? null,
          productId: candidate?.productId ?? null,
          codeCount: candidate?.codeCount ?? 0,
        });
      }
      if (values.length > 0) {
        await tx.insert(schema.disaggregationDocumentLines).values(values);
        await tx
          .update(schema.disaggregationDocuments)
          .set({ updatedAt: sql`now()` })
          .where(
            and(
              eq(schema.disaggregationDocuments.tenantId, tenantId),
              eq(schema.disaggregationDocuments.id, documentId),
            ),
          );
      }
      return { lines: await this.listLinesTx(tx, tenantId, documentId) };
    });
  }

  async importLines(tenantId: string, documentId: string, tokens: string[]) {
    for (let i = 0; i < tokens.length; i += 500) {
      await this.addLines(tenantId, documentId, tokens.slice(i, i + 500));
    }
    await this.db
      .update(schema.disaggregationDocuments)
      .set({ source: "import", updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.disaggregationDocuments.tenantId, tenantId),
          eq(schema.disaggregationDocuments.id, documentId),
        ),
      );
    return { lines: await this.listLines(tenantId, documentId) };
  }

  /** Same TOCTOU guard as `addLines`: document row `FOR UPDATE`, `draft` re-checked inside the lock, delete + touch inside the same tx. */
  async removeLine(tenantId: string, documentId: string, lineId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [doc] = await tx
        .select()
        .from(schema.disaggregationDocuments)
        .where(
          and(
            eq(schema.disaggregationDocuments.tenantId, tenantId),
            eq(schema.disaggregationDocuments.id, documentId),
          ),
        )
        .for("update");
      if (!doc) throw new NotFoundException();
      this.assertDraft(doc);

      const removed = await tx
        .delete(schema.disaggregationDocumentLines)
        .where(
          and(
            eq(schema.disaggregationDocumentLines.tenantId, tenantId),
            eq(schema.disaggregationDocumentLines.documentId, documentId),
            eq(schema.disaggregationDocumentLines.id, lineId),
          ),
        )
        .returning({ id: schema.disaggregationDocumentLines.id });
      if (removed.length === 0) throw new NotFoundException();

      await tx
        .update(schema.disaggregationDocuments)
        .set({ updatedAt: sql`now()` })
        .where(
          and(
            eq(schema.disaggregationDocuments.tenantId, tenantId),
            eq(schema.disaggregationDocuments.id, documentId),
          ),
        );
    });
  }

  /**
   * Batched sibling of `toDocumentDto` for `listDocuments`: one grouped
   * aggregate query and one reason lookup for the whole page, instead of
   * up to 2 extra round-trips per row (N+1 at PAGE_SIZE rows/page).
   */
  private async toDocumentDtos(
    tenantId: string,
    rows: (typeof schema.disaggregationDocuments.$inferSelect)[],
  ): Promise<DocumentDto[]> {
    if (rows.length === 0) return [];
    const documentIds = rows.map((row) => row.id);
    const aggRows = await this.db
      .select({
        documentId: schema.disaggregationDocumentLines.documentId,
        lineCount: count(),
        codeCount: sum(schema.disaggregationDocumentLines.codeCount).mapWith(Number),
      })
      .from(schema.disaggregationDocumentLines)
      .where(
        and(
          eq(schema.disaggregationDocumentLines.tenantId, tenantId),
          inArray(schema.disaggregationDocumentLines.documentId, documentIds),
        ),
      )
      .groupBy(schema.disaggregationDocumentLines.documentId);
    const aggByDocumentId = new Map(aggRows.map((agg) => [agg.documentId, agg]));

    const reasonIds = [...new Set(rows.flatMap((row) => (row.reasonId ? [row.reasonId] : [])))];
    const reasonNameById = new Map<string, string>();
    if (reasonIds.length > 0) {
      const reasonRows = await this.db
        .select({ id: schema.disaggregationReasons.id, name: schema.disaggregationReasons.name })
        .from(schema.disaggregationReasons)
        .where(
          and(
            eq(schema.disaggregationReasons.tenantId, tenantId),
            inArray(schema.disaggregationReasons.id, reasonIds),
          ),
        );
      for (const reason of reasonRows) reasonNameById.set(reason.id, reason.name);
    }

    const creatorIds = [...new Set(rows.map((row) => row.createdByUserId))];
    const creatorNameById = new Map<string, string>();
    if (creatorIds.length > 0) {
      const creatorRows = await this.db
        .select({ id: schema.user.id, name: schema.user.name })
        .from(schema.user)
        .where(inArray(schema.user.id, creatorIds));
      for (const creator of creatorRows) creatorNameById.set(creator.id, creator.name);
    }

    return rows.map((row) => {
      const agg = aggByDocumentId.get(row.id);
      return {
        id: row.id,
        docNo: row.docNo,
        status: row.status,
        reasonId: row.reasonId,
        reasonName: row.reasonId ? (reasonNameById.get(row.reasonId) ?? null) : null,
        comment: row.comment,
        source: row.source,
        lineCount: agg?.lineCount ?? 0,
        codeCount: agg?.codeCount ?? 0,
        createdByUserId: row.createdByUserId,
        createdByName: creatorNameById.get(row.createdByUserId) ?? null,
        createdAt: row.createdAt,
        appliedAt: row.appliedAt,
        appliedByUserId: row.appliedByUserId,
        cancelledAt: row.cancelledAt,
      };
    });
  }

  private async toDocumentDto(
    tenantId: string,
    row: typeof schema.disaggregationDocuments.$inferSelect,
  ): Promise<DocumentDto> {
    const [agg] = await this.db
      .select({
        lineCount: count(),
        codeCount: sum(schema.disaggregationDocumentLines.codeCount).mapWith(Number),
      })
      .from(schema.disaggregationDocumentLines)
      .where(
        and(
          eq(schema.disaggregationDocumentLines.tenantId, tenantId),
          eq(schema.disaggregationDocumentLines.documentId, row.id),
        ),
      );
    let reasonName: string | null = null;
    if (row.reasonId) {
      const [reason] = await this.db
        .select({ name: schema.disaggregationReasons.name })
        .from(schema.disaggregationReasons)
        .where(
          and(
            eq(schema.disaggregationReasons.tenantId, tenantId),
            eq(schema.disaggregationReasons.id, row.reasonId),
          ),
        );
      reasonName = reason?.name ?? null;
    }
    const [creator] = await this.db
      .select({ name: schema.user.name })
      .from(schema.user)
      .where(eq(schema.user.id, row.createdByUserId));
    return {
      id: row.id,
      docNo: row.docNo,
      status: row.status,
      reasonId: row.reasonId,
      reasonName,
      comment: row.comment,
      source: row.source,
      lineCount: agg?.lineCount ?? 0,
      codeCount: agg?.codeCount ?? 0,
      createdByUserId: row.createdByUserId,
      createdByName: creator?.name ?? null,
      createdAt: row.createdAt,
      appliedAt: row.appliedAt,
      appliedByUserId: row.appliedByUserId,
      cancelledAt: row.cancelledAt,
    };
  }
}
