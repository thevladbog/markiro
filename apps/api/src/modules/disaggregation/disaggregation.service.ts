import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gte, inArray, lte, sql, sum } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { formatSsccWithAi } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { nextDocNo } from "./doc-number";
import type {
  CreateDocumentDto,
  DocumentDetailDto,
  DocumentDto,
  LineDto,
  ListDocumentsQueryDto,
  UpdateDocumentDto,
} from "./dto";

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
      return this.toDocumentDto(tenantId, row!);
    });
  }

  async listDocuments(tenantId: string, query: ListDocumentsQueryDto) {
    const where = and(
      eq(schema.disaggregationDocuments.tenantId, tenantId),
      query.status ? eq(schema.disaggregationDocuments.status, query.status) : undefined,
      query.reasonId ? eq(schema.disaggregationDocuments.reasonId, query.reasonId) : undefined,
      query.from ? gte(schema.disaggregationDocuments.createdAt, query.from) : undefined,
      query.to ? lte(schema.disaggregationDocuments.createdAt, query.to) : undefined,
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
    const row = await this.findDocument(tenantId, id);
    this.assertDraft(row);
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
        ),
      )
      .returning();
    return this.toDocumentDto(tenantId, updated!);
  }

  async cancelDocument(tenantId: string, id: string): Promise<DocumentDto> {
    const row = await this.findDocument(tenantId, id);
    this.assertDraft(row);
    const [updated] = await this.db
      .update(schema.disaggregationDocuments)
      .set({ status: "cancelled", cancelledAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.disaggregationDocuments.tenantId, tenantId),
          eq(schema.disaggregationDocuments.id, id),
        ),
      )
      .returning();
    return this.toDocumentDto(tenantId, updated!);
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

  async listLines(tenantId: string, documentId: string): Promise<LineDto[]> {
    const rows = await this.db
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
      .orderBy(schema.disaggregationDocumentLines.createdAt);
    return rows.map((r) => ({ ...r, sscc: r.sscc === null ? null : formatSsccWithAi(r.sscc) }));
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
      createdAt: row.createdAt,
      appliedAt: row.appliedAt,
      appliedByUserId: row.appliedByUserId,
      cancelledAt: row.cancelledAt,
    };
  }
}
