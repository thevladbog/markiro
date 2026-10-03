import { schema, type Db } from "@markiro/db";
import {
  US_CAPABILITY,
  buildUsPlanSnapshot,
  buildUsPlanDraftFactSources,
  type UsCapability,
  type UsPlanApprovalInput,
} from "@markiro/domain";
import {
  platformUuidSchema,
  usPlanValidateBodySchema,
  usPlanPreviewBodySchema,
  usPlanValidationResponseSchema,
  type UsPlanValidationResponse,
} from "@markiro/platform-contracts";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { UsDevelopmentOwnerStore } from "../../../deployment/us-development-owner";
import { authorizeUsMasterData, parseMasterDataInput } from "../master-data/us-master-data-support";
import { readUsPlanConfiguration } from "./us-plan-configuration";
import { parseUsPlanDraftRow } from "./us-plan-model";
import { renderUsPlanDraftPreview } from "./us-plan-pdf";
import { validateUsPlanSavedContent } from "./us-plan-validation";

export class UsPlanInspectionStore {
  constructor(
    private readonly db: Db,
    private readonly publicationAvailability: UsPlanValidationResponse["publicationAvailability"],
    private readonly render: typeof renderUsPlanDraftPreview = renderUsPlanDraftPreview,
  ) {}

  private capture(
    tenantId: string,
    actor: string,
    rawId: unknown,
    revision: number,
    confirmations: UsPlanApprovalInput["confirmations"],
    capability: UsCapability,
    mode: "approval" | "preview",
  ) {
    return this.db.transaction(
      async (tx) => {
        const profile = await authorizeUsMasterData(tx, tenantId, actor, capability);
        if (profile !== "US_FSMA204_PROCESSOR")
          throw new ForbiddenException({ code: "us_plan_profile_unsupported" });
        const id = parseMasterDataInput(platformUuidSchema, rawId);
        const versions = schema.traceabilityPlanVersions;
        const [row] = await tx
          .select()
          .from(versions)
          .where(and(eq(versions.tenantId, tenantId), eq(versions.id, id)));
        if (!row) throw new NotFoundException({ code: "us_plan_version_not_found" });
        if (row.status !== "draft") throw new ConflictException({ code: "us_plan_not_draft" });
        if (row.draftRevision !== revision)
          throw new ConflictException({ code: "us_plan_revision_conflict" });
        const draft = parseUsPlanDraftRow(row);
        const { facts } = await readUsPlanConfiguration(tx, tenantId);
        const seed = await new UsDevelopmentOwnerStore(this.db).verifyTrustedSeed(
          tenantId,
          new Date(),
          tx,
        );
        const provenance = seed ? "trusted_synthetic" : "operational";
        const issues = validateUsPlanSavedContent(
          {
            ...draft,
            profileCode: facts.profileCode,
            tlcSourceLocationCount: facts.tlcSourceLocations.length,
            provenance,
            confirmations,
          },
          facts,
          mode,
        );
        return { draft, facts, provenance, issues } as const;
      },
      { isolationLevel: "repeatable read" },
    );
  }

  async validate(
    tenantId: string,
    actor: string,
    rawId: unknown,
    body: unknown,
  ): Promise<UsPlanValidationResponse> {
    const input = parseMasterDataInput(usPlanValidateBodySchema, body);
    const captured = await this.capture(
      tenantId,
      actor,
      rawId,
      input.expectedRevision,
      input.confirmations,
      US_CAPABILITY.QA_MANAGE,
      "approval",
    );
    return usPlanValidationResponseSchema.parse({
      versionId: captured.draft.id,
      draftRevision: captured.draft.draftRevision,
      issues: captured.issues,
      publicationAvailability: this.publicationAvailability,
    });
  }

  async preview(
    tenantId: string,
    actor: string,
    rawId: unknown,
    body: unknown,
  ): Promise<{ bytes: Buffer; draftRevision: number }> {
    const input = parseMasterDataInput(usPlanPreviewBodySchema, body);
    const captured = await this.capture(
      tenantId,
      actor,
      rawId,
      input.expectedRevision,
      { procedures: false, backupAndRecovery: false, contact: false, nonFarmScope: false },
      US_CAPABILITY.EXPORT_READ,
      "preview",
    );
    if (captured.issues.length)
      throw new ConflictException({ code: "us_plan_validation_failed", issues: captured.issues });
    const bytes = await this.render({
      versionNumber: captured.draft.versionNumber,
      changeSummary: captured.draft.changeSummary,
      snapshot: buildUsPlanSnapshot(captured.facts, captured.draft.sections, captured.provenance),
      factSources: buildUsPlanDraftFactSources(captured.facts, captured.draft.sections),
    });
    return { bytes, draftRevision: captured.draft.draftRevision };
  }
}
