import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import type { LabelTemplateSpec } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import type {
  CreateLabelTemplateDto,
  LabelTemplateDto,
  LabelTemplateSummaryDto,
  ListLabelTemplatesResponseDto,
  UpdateLabelTemplateDto,
} from "./dto";

type LabelTemplateRow = typeof schema.labelTemplates.$inferSelect;

@Injectable()
export class LabelTemplatesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** List a tenant's label templates as size/DPI/language summaries (spec projected, not shipped whole). */
  async listLabelTemplates(tenantId: string): Promise<ListLabelTemplatesResponseDto> {
    const rows = await this.db
      .select()
      .from(schema.labelTemplates)
      .where(eq(schema.labelTemplates.tenantId, tenantId));

    return { items: rows.map((row) => this.rowToSummaryDto(row)) };
  }

  /** Get a single label template by id (must belong to the tenant), with the full spec. */
  async getLabelTemplate(tenantId: string, id: string): Promise<LabelTemplateDto> {
    const row = await this.findRow(tenantId, id);
    if (!row) {
      throw new NotFoundException();
    }
    return this.rowToDto(row);
  }

  /** Create a label template. `data.spec` has already been domain-validated by the zod pipe. */
  async createLabelTemplate(
    tenantId: string,
    data: CreateLabelTemplateDto,
  ): Promise<LabelTemplateDto> {
    const [row] = await this.db
      .insert(schema.labelTemplates)
      .values({
        tenantId,
        name: data.name,
        spec: data.spec,
      })
      .returning();

    if (!row) {
      throw new InternalServerErrorException("Failed to create label template");
    }
    return this.rowToDto(row);
  }

  /**
   * Update a label template (partial update, preserves untouched fields).
   * `updatedAt` is bumped on every successful write, sourced from the
   * database's own clock (`now()`) rather than the app process's -- both
   * `created_at` and `updated_at` are DB-side defaults/writes, so comparing
   * them is never subject to app/DB clock skew.
   */
  async updateLabelTemplate(
    tenantId: string,
    id: string,
    data: UpdateLabelTemplateDto,
  ): Promise<LabelTemplateDto> {
    const setClause: Record<string, unknown> = { updatedAt: sql`now()` };
    if (data.name !== undefined) setClause.name = data.name;
    if (data.spec !== undefined) setClause.spec = data.spec;

    const [row] = await this.db
      .update(schema.labelTemplates)
      .set(setClause)
      .where(and(eq(schema.labelTemplates.tenantId, tenantId), eq(schema.labelTemplates.id, id)))
      .returning();

    if (!row) {
      throw new NotFoundException("Label template not found or does not belong to this tenant");
    }
    return this.rowToDto(row);
  }

  /**
   * Delete a label template. Returns 404 if not found. Referenced-delete
   * (409 when a product/shift still points at this template) lands in
   * Task 7 once those FKs exist -- today the delete is unconditional.
   */
  async deleteLabelTemplate(tenantId: string, id: string): Promise<void> {
    const current = await this.findRow(tenantId, id);
    if (!current) {
      throw new NotFoundException();
    }

    try {
      await this.db
        .delete(schema.labelTemplates)
        .where(and(eq(schema.labelTemplates.tenantId, tenantId), eq(schema.labelTemplates.id, id)));
    } catch (error) {
      // Catch PostgreSQL FK violation errors (code 23503); check both direct
      // code property and nested cause.code (node-postgres wraps it either way).
      const err = error as Error & { code?: string; cause?: unknown };
      const errorCode = err?.code || (err?.cause as Record<string, string> | undefined)?.code;
      if (errorCode === "23503") {
        throw new ConflictException("Label template is referenced by products or shifts");
      }
      throw error;
    }
  }

  private async findRow(tenantId: string, id: string): Promise<LabelTemplateRow | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.labelTemplates)
      .where(and(eq(schema.labelTemplates.tenantId, tenantId), eq(schema.labelTemplates.id, id)));
    return row;
  }

  private rowToDto(row: LabelTemplateRow): LabelTemplateDto {
    return {
      id: row.id,
      name: row.name,
      spec: row.spec as LabelTemplateSpec,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private rowToSummaryDto(row: LabelTemplateRow): LabelTemplateSummaryDto {
    const spec = row.spec as LabelTemplateSpec;
    return {
      id: row.id,
      name: row.name,
      widthMm: spec.widthMm,
      heightMm: spec.heightMm,
      dpi: spec.dpi,
      language: spec.language,
      updatedAt: row.updatedAt,
    };
  }
}
