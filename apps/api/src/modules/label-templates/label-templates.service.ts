import { randomUUID } from "node:crypto";
import {
  EntitlementAdmissionService,
  admissionScopeDigest,
} from "../../subscriptions/entitlement-admission.service";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  assertDuplicateTemplate,
  DomainError,
  isBoxLabelTemplateEligible,
  isPalletLabelTemplateEligible,
  type LabelTemplatePurpose,
  type StoredLabelTemplateSpec,
  parseStoredLabelTemplate,
  isPalletSheetSpec,
} from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import {
  assertKnownProductGroupCodes,
  findLabelTemplateDefaultUsage,
  findPalletLabelTemplateDefaultUsage,
  findPalletSheetTemplateDefaultUsage,
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
  "shifts_tenant_validation_print_template_fk",
  "inventories_tenant_box_label_template_fk",
  // Pallet counterparts of the box constraints above (slice 06d): deleting
  // or disabling a template a pallet default still points at must be
  // refused the same way.
  "org_pallet_label_template_defaults_template_tenant_fk",
  "org_profiles_pallet_label_template_tenant_fk",
  "shifts_tenant_pallet_label_template_fk",
  "shifts_tenant_pallet_sheet_template_fk",
  "org_profiles_pallet_sheet_template_tenant_fk",
  "org_pallet_sheet_template_defaults_template_tenant_fk",
]);

@Injectable()
export class LabelTemplatesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly admission: EntitlementAdmissionService,
  ) {}

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
    includeSheets = false,
  ): Promise<ListLabelTemplatesResponseDto> {
    const conditions = [eq(schema.labelTemplates.tenantId, tenantId)];
    if (!includeSheets) conditions.push(eq(schema.labelTemplates.format, "label_v1"));
    if (query.enabled === "true") conditions.push(eq(schema.labelTemplates.enabled, true));
    if (query.enabled === "false") conditions.push(eq(schema.labelTemplates.enabled, false));
    const rows = await this.db
      .select()
      .from(schema.labelTemplates)
      .where(and(...conditions))
      .orderBy(desc(schema.labelTemplates.updatedAt));

    return { items: rows.map((row) => this.rowToSummaryDto(row, includeSheets)) };
  }

  /** Get a single label template by id (must belong to the tenant), with the full spec. */
  async getLabelTemplate(
    tenantId: string,
    id: string,
    includeSheets = false,
  ): Promise<LabelTemplateDto> {
    const row = await this.findRow(tenantId, id);
    if (!row) {
      throw new NotFoundException();
    }
    if (row.format === "pallet_sheet_v2" && !includeSheets)
      throw new BadRequestException({
        code: "LABEL_TEMPLATE_FORMAT_UNSUPPORTED",
        message: "This client does not support pallet sheets",
      });
    return this.rowToDto(row, includeSheets);
  }

  /** Create a label template. `data.spec` has already been domain-validated by the zod pipe. */
  async createLabelTemplate(
    tenantId: string,
    data: CreateLabelTemplateDto,
    actorUserId: string,
  ): Promise<LabelTemplateDto> {
    this.assertPurposeSpec(data.purpose, data.spec);
    if (data.chzProductGroupCodes !== null) {
      await assertKnownProductGroupCodes(this.db, data.chzProductGroupCodes);
    }
    // The existing admission protocol hashes the legacy input shape. Adding
    // storage metadata must not change that scope for unchanged V1 clients.
    const { format, ...legacyScope } = data;
    const id = randomUUID();
    const facts = await this.admission.capture(tenantId);
    const row = await this.db.transaction(async (tx) => {
      await this.admission.observe({
        tenantId,
        actor: { domain: "cabinet", id: actorUserId },
        facts,
        operationId: "labelEditor.template.write.v1",
        transaction: tx,
        runtime: { enabled: true, observedAt: new Date() },
        scopeDigest: admissionScopeDigest({
          action: "create",
          templateId: id,
          ...(format === "label_v1" ? legacyScope : data),
        }),
      });
      const [created] = await tx
        .insert(schema.labelTemplates)
        .values({ id, tenantId, ...data })
        .returning();
      if (created?.format === "pallet_sheet_v2")
        await this.auditSheet(tx, tenantId, actorUserId, "created", created);
      return created;
    });

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
    actorUserId: string,
  ): Promise<LabelTemplateDto> {
    const facts = await this.admission.capture(tenantId);
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.labelTemplates)
        .where(and(eq(schema.labelTemplates.tenantId, tenantId), eq(schema.labelTemplates.id, id)))
        .for("update");
      if (!current) {
        throw new NotFoundException("Label template not found or does not belong to this tenant");
      }
      if (current.format === "pallet_sheet_v2" && data.expectedRevision === undefined)
        throw new BadRequestException({
          code: "LABEL_TEMPLATE_REVISION_REQUIRED",
          message: "expectedRevision is required for pallet sheets",
        });
      if (data.expectedRevision !== undefined && data.expectedRevision !== current.revision)
        throw new ConflictException({
          code: "LABEL_TEMPLATE_REVISION_CONFLICT",
          message: "The template has been changed by another editor",
          revision: current.revision,
        });
      const incomingFormat =
        data.spec === undefined
          ? data.format
          : isPalletSheetSpec(data.spec)
            ? "pallet_sheet_v2"
            : "label_v1";
      if (
        (incomingFormat !== undefined && incomingFormat !== current.format) ||
        (data.format !== undefined && data.format !== current.format)
      )
        throw new ConflictException({
          code: "LABEL_TEMPLATE_FORMAT_IMMUTABLE",
          message: "Template format cannot change; create a copy",
        });
      if (data.purpose !== undefined && data.purpose !== current.purpose) {
        throw new ConflictException({
          code: "LABEL_TEMPLATE_PURPOSE_IMMUTABLE",
          message: "Label template purpose cannot change",
        });
      }
      if (data.spec !== undefined) this.assertPurposeSpec(current.purpose, data.spec);
      if (data.chzProductGroupCodes) {
        await assertKnownProductGroupCodes(tx, data.chzProductGroupCodes);
      }

      const nextEnabled = data.enabled ?? current.enabled;
      const nextCodes =
        data.chzProductGroupCodes !== undefined
          ? data.chzProductGroupCodes
          : current.chzProductGroupCodes;
      if (data.enabled !== undefined || data.chzProductGroupCodes !== undefined) {
        const next = {
          purpose: current.purpose,
          enabled: nextEnabled,
          chzProductGroupCodes: nextCodes,
        };
        // A template's purpose is immutable (checked above), so only the
        // usage table matching ITS purpose can ever reference it -- a box
        // template can be an org/category BOX default, a pallet template a
        // pallet one, never the other. Checking the matching pair keeps this
        // to one usage query instead of always running both.
        const usage =
          current.purpose === "pallet"
            ? current.format === "pallet_sheet_v2"
              ? await findPalletSheetTemplateDefaultUsage(tx, tenantId, id)
              : await findPalletLabelTemplateDefaultUsage(tx, tenantId, id)
            : await findLabelTemplateDefaultUsage(tx, tenantId, id);
        const isEligible =
          current.purpose === "pallet" ? isPalletLabelTemplateEligible : isBoxLabelTemplateEligible;
        const organizationDefault =
          usage.organizationDefault && (!nextEnabled || nextCodes !== null);
        const categoryDefaults = usage.categoryDefaults.filter((code) => !isEligible(next, code));
        if (organizationDefault || categoryDefaults.length > 0) {
          throw new ConflictException({
            code: "LABEL_TEMPLATE_IS_DEFAULT",
            message: "Label template is used as a default and would stop being eligible",
            organizationDefault,
            categoryDefaults,
          });
        }
      }

      const setClause: Record<string, unknown> = {
        updatedAt: sql`now()`,
        revision: sql`${schema.labelTemplates.revision} + 1`,
      };
      if (data.name !== undefined) setClause.name = data.name;
      if (data.spec !== undefined) setClause.spec = data.spec;
      if (data.enabled !== undefined) setClause.enabled = data.enabled;
      if (data.chzProductGroupCodes !== undefined) {
        setClause.chzProductGroupCodes = data.chzProductGroupCodes;
      }

      const changed = Object.entries(data).some(
        ([key, value]) =>
          key !== "expectedRevision" &&
          admissionScopeDigest(value) !==
            admissionScopeDigest(current[key as keyof LabelTemplateRow]),
      );
      if (changed)
        await this.admission.observe({
          tenantId,
          actor: { domain: "cabinet", id: actorUserId },
          facts,
          operationId: "labelEditor.template.write.v1",
          transaction: tx,
          runtime: { enabled: true, observedAt: new Date() },
          scopeDigest: admissionScopeDigest({ action: "update", templateId: id, changes: data }),
        });
      const [row] = await tx
        .update(schema.labelTemplates)
        .set(setClause)
        .where(and(eq(schema.labelTemplates.tenantId, tenantId), eq(schema.labelTemplates.id, id)))
        .returning();
      if (!row) {
        throw new NotFoundException("Label template not found or does not belong to this tenant");
      }
      if (row.format === "pallet_sheet_v2")
        await this.auditSheet(tx, tenantId, actorUserId, "updated", row, current.revision);
      return this.rowToDto(row);
    });
  }

  /**
   * Delete a tenant template under its row lock. A concurrent delete returns
   * 404; known default/product/shift references retain their 409 mapping.
   */
  async deleteLabelTemplate(tenantId: string, id: string, actorUserId: string): Promise<void> {
    const facts = await this.admission.capture(tenantId);
    try {
      await this.db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(schema.labelTemplates)
          .where(
            and(eq(schema.labelTemplates.tenantId, tenantId), eq(schema.labelTemplates.id, id)),
          )
          .for("update");
        if (!current) throw new NotFoundException();
        await this.admission.observe({
          tenantId,
          actor: { domain: "cabinet", id: actorUserId },
          facts,
          operationId: "labelEditor.template.write.v1",
          transaction: tx,
          runtime: { enabled: true, observedAt: new Date() },
          scopeDigest: admissionScopeDigest({ action: "delete", templateId: id }),
        });
        if (current.format === "pallet_sheet_v2")
          await this.auditSheet(tx, tenantId, actorUserId, "deleted", current);
        await tx
          .delete(schema.labelTemplates)
          .where(
            and(eq(schema.labelTemplates.tenantId, tenantId), eq(schema.labelTemplates.id, id)),
          );
      });
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

  private assertPurposeSpec(purpose: LabelTemplatePurpose, spec: StoredLabelTemplateSpec): void {
    if (isPalletSheetSpec(spec)) {
      if (purpose !== "pallet")
        throw new BadRequestException({
          code: "LABEL_TEMPLATE_PURPOSE_INVALID",
          message: "Pallet sheets require pallet purpose",
        });
      return;
    }
    if (purpose !== "product_duplicate") return;
    try {
      assertDuplicateTemplate(spec);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      throw new BadRequestException({ code: error.code, message: error.message });
    }
  }

  private async findRow(tenantId: string, id: string): Promise<LabelTemplateRow | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.labelTemplates)
      .where(and(eq(schema.labelTemplates.tenantId, tenantId), eq(schema.labelTemplates.id, id)));
    return row;
  }

  private rowToDto(row: LabelTemplateRow, includeMetadata = false): LabelTemplateDto {
    return {
      id: row.id,
      name: row.name,
      purpose: row.purpose,
      spec: parseStoredLabelTemplate(row.spec),
      ...(includeMetadata || row.format === "pallet_sheet_v2"
        ? { format: row.format, revision: row.revision }
        : {}),
      enabled: row.enabled,
      chzProductGroupCodes: row.chzProductGroupCodes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private rowToSummaryDto(
    row: LabelTemplateRow,
    includeMetadata: boolean,
  ): LabelTemplateSummaryDto {
    const spec = parseStoredLabelTemplate(row.spec);
    const common = {
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      chzProductGroupCodes: row.chzProductGroupCodes,
      updatedAt: row.updatedAt,
    };
    if (isPalletSheetSpec(spec))
      return {
        ...common,
        purpose: "pallet",
        format: "pallet_sheet_v2",
        revision: row.revision,
        dpi: 300,
        page: { size: "A4", orientation: spec.page.orientation, copies: spec.page.copies },
      };
    return {
      ...common,
      purpose: row.purpose,
      widthMm: spec.widthMm,
      heightMm: spec.heightMm,
      dpi: spec.dpi,
      language: spec.language,
      ...(includeMetadata ? { format: "label_v1" as const, revision: row.revision } : {}),
    };
  }

  private async auditSheet(
    tx: Pick<Db, "insert">,
    tenantId: string,
    actorUserId: string,
    action: "created" | "updated" | "deleted",
    row: LabelTemplateRow,
    previousRevision?: number,
  ): Promise<void> {
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: tenantId,
      actorUserId,
      action: `tenant.pallet_sheet_template.${action}`,
      outcome: "success",
      targetType: "label_template",
      targetId: row.id,
      ...(previousRevision === undefined ? {} : { before: { revision: previousRevision } }),
      after: { templateId: row.id, format: row.format, revision: row.revision },
    });
  }
}
