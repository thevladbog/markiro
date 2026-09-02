import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { isBoxLabelTemplateEligible, type LabelTemplateSpec } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import {
  assertKnownProductGroupCodes,
  findLabelTemplateDefaultUsage,
} from "./box-label-template-eligibility";
import type {
  CreateLabelTemplateDto,
  LabelTemplateDto,
  LabelTemplateSummaryDto,
  ListLabelTemplatesQueryDto,
  ListLabelTemplatesResponseDto,
  UpdateLabelTemplateDto,
} from "./dto";

type LabelTemplateRow = typeof schema.labelTemplates.$inferSelect;

const LABEL_TEMPLATE_REFERENCE_CONSTRAINTS = new Set([
  "org_profiles_box_label_template_tenant_fk",
  "org_box_label_template_defaults_template_tenant_fk",
  "products_tenant_default_label_template_fk",
  "shifts_tenant_label_template_fk",
  "shifts_tenant_box_label_template_fk",
  "inventories_tenant_box_label_template_fk",
]);

@Injectable()
export class LabelTemplatesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * List a tenant's label templates as size/DPI/language summaries (spec
   * projected, not shipped whole). Ordered most-recently-updated first
   * (`updatedAt` desc) — without an explicit `ORDER BY`, Postgres gives no
   * ordering guarantee at all (it may happen to return insertion order on a
   * small table today, but that is an implementation detail, not a
   * contract), so the library screen's list would be free to silently
   * reshuffle between requests.
   */
  async listLabelTemplates(
    tenantId: string,
    query: ListLabelTemplatesQueryDto,
  ): Promise<ListLabelTemplatesResponseDto> {
    const conditions = [eq(schema.labelTemplates.tenantId, tenantId)];
    if (query.enabled === "true") conditions.push(eq(schema.labelTemplates.enabled, true));
    if (query.enabled === "false") conditions.push(eq(schema.labelTemplates.enabled, false));
    const rows = await this.db
      .select()
      .from(schema.labelTemplates)
      .where(and(...conditions))
      .orderBy(desc(schema.labelTemplates.updatedAt));

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
    if (data.chzProductGroupCodes !== null) {
      await assertKnownProductGroupCodes(this.db, data.chzProductGroupCodes);
    }
    const [row] = await this.db
      .insert(schema.labelTemplates)
      .values({
        tenantId,
        name: data.name,
        spec: data.spec,
        enabled: data.enabled,
        chzProductGroupCodes: data.chzProductGroupCodes,
      })
      .returning();

    if (!row) {
      throw new InternalServerErrorException("Failed to create label template");
    }
    return this.rowToDto(row);
  }

  /**
   * Partial update inside one transaction. The row is locked FOR UPDATE so a
   * concurrent org-profile write (which locks the template FOR SHARE) cannot
   * make a default point at a template that is being disabled or narrowed.
   * `updatedAt` is sourced from the database's own clock (`now()`).
   */
  async updateLabelTemplate(
    tenantId: string,
    id: string,
    data: UpdateLabelTemplateDto,
  ): Promise<LabelTemplateDto> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.labelTemplates)
        .where(and(eq(schema.labelTemplates.tenantId, tenantId), eq(schema.labelTemplates.id, id)))
        .for("update");
      if (!current) {
        throw new NotFoundException("Label template not found or does not belong to this tenant");
      }
      if (data.chzProductGroupCodes) {
        await assertKnownProductGroupCodes(tx, data.chzProductGroupCodes);
      }

      const nextEnabled = data.enabled ?? current.enabled;
      const nextCodes =
        data.chzProductGroupCodes !== undefined
          ? data.chzProductGroupCodes
          : current.chzProductGroupCodes;
      if (data.enabled !== undefined || data.chzProductGroupCodes !== undefined) {
        const usage = await findLabelTemplateDefaultUsage(tx, tenantId, id);
        const next = { enabled: nextEnabled, chzProductGroupCodes: nextCodes };
        const organizationDefault =
          usage.organizationDefault && (!nextEnabled || nextCodes !== null);
        const categoryDefaults = usage.categoryDefaults.filter(
          (code) => !isBoxLabelTemplateEligible(next, code),
        );
        if (organizationDefault || categoryDefaults.length > 0) {
          throw new ConflictException({
            code: "LABEL_TEMPLATE_IS_DEFAULT",
            message: "Label template is used as a default and would stop being eligible",
            organizationDefault,
            categoryDefaults,
          });
        }
      }

      const setClause: Record<string, unknown> = { updatedAt: sql`now()` };
      if (data.name !== undefined) setClause.name = data.name;
      if (data.spec !== undefined) setClause.spec = data.spec;
      if (data.enabled !== undefined) setClause.enabled = data.enabled;
      if (data.chzProductGroupCodes !== undefined) {
        setClause.chzProductGroupCodes = data.chzProductGroupCodes;
      }

      const [row] = await tx
        .update(schema.labelTemplates)
        .set(setClause)
        .where(and(eq(schema.labelTemplates.tenantId, tenantId), eq(schema.labelTemplates.id, id)))
        .returning();
      if (!row) {
        throw new NotFoundException("Label template not found or does not belong to this tenant");
      }
      return this.rowToDto(row);
    });
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
      // Catch only known PostgreSQL FK references to label_templates. Drizzle
      // may place the database fields directly on the error or under cause.
      const err = error as Error & { code?: string; constraint?: string; cause?: unknown };
      const cause = err?.cause as { code?: string; constraint?: string } | undefined;
      const errorCode = err?.code ?? cause?.code;
      const constraint = err?.constraint ?? cause?.constraint;
      if (
        errorCode === "23503" &&
        constraint &&
        LABEL_TEMPLATE_REFERENCE_CONSTRAINTS.has(constraint)
      ) {
        throw new ConflictException(
          "Label template is referenced by an organization default, product, shift, or inventory",
        );
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
      enabled: row.enabled,
      chzProductGroupCodes: row.chzProductGroupCodes,
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
      enabled: row.enabled,
      chzProductGroupCodes: row.chzProductGroupCodes,
      updatedAt: row.updatedAt,
    };
  }
}
