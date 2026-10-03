import { schema, type Db } from "@markiro/db";
import {
  compareUsPlanConfiguredFacts,
  US_CAPABILITY,
  type UsPlanFactSource,
} from "@markiro/domain";
import {
  platformUuidSchema,
  usPlanDetailResponseSchema,
  usPlanListResponseSchema,
  type UsPlanDetailResponse,
  type UsPlanListResponse,
} from "@markiro/platform-contracts";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { UsDevelopmentOwnerStore } from "../../../deployment/us-development-owner";
import {
  authorizeUsMasterData,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { readUsPlanConfiguration } from "./us-plan-configuration";
import { parseUsPlanDraftRow, type UsPlanVersionRow } from "./us-plan-model";
import { parseUsPlanPublishedRow } from "./us-plan-published";

function publicSource(source: UsPlanFactSource) {
  return source.origin === "synthetic_fixture" ? { origin: "synthetic_fixture" as const } : source;
}

/** Internal read projection; identity must come from the verified US session boundary. */
export class UsPlanReadStore {
  constructor(
    private readonly db: Db,
    private readonly publicationAvailability: "available" | "artifact_storage_unconfigured",
  ) {}

  private async context(tx: UsMasterDataTransaction, tenantId: string, actorUserId: string) {
    const profile = await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
    if (profile !== "US_FSMA204_PROCESSOR")
      throw new ForbiddenException({ code: "us_plan_profile_unsupported" });
    const config = await readUsPlanConfiguration(tx, tenantId);
    const seed = await new UsDevelopmentOwnerStore(this.db).verifyTrustedSeed(
      tenantId,
      new Date(),
      tx,
    );
    return {
      facts: config.facts,
      provenance: seed ? ("trusted_synthetic" as const) : ("operational" as const),
    };
  }

  private item(row: UsPlanVersionRow, draftProvenance: "operational" | "trusted_synthetic") {
    const common = {
      id: row.id,
      versionNumber: row.versionNumber,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
    if (row.status === "draft") {
      const draft = parseUsPlanDraftRow(row);
      return {
        ...common,
        status: draft.status,
        draftRevision: draft.draftRevision,
        provenance: draftProvenance,
      };
    }
    const published = parseUsPlanPublishedRow(row);
    return {
      ...common,
      status: published.status,
      provenance: published.evidence.snapshot.provenance,
      approvedAt: published.approvedAt,
      supersededAt: published.supersededAt,
      retainThrough: published.retainThrough,
      artifact: {
        sha256: published.artifact.sha256,
        byteSize: published.artifact.byteSize,
        rendererVersion: published.artifact.rendererVersion,
      },
    };
  }

  async list(tenantId: string, actorUserId: string): Promise<UsPlanListResponse> {
    return this.db.transaction(
      async (tx) => {
        const context = await this.context(tx, tenantId, actorUserId);
        const rows = await tx
          .select()
          .from(schema.traceabilityPlanVersions)
          .where(eq(schema.traceabilityPlanVersions.tenantId, tenantId))
          .orderBy(desc(schema.traceabilityPlanVersions.versionNumber));
        const effective = rows.find((row) => row.status === "effective");
        return usPlanListResponseSchema.parse({
          items: rows.map((row) => this.item(row, context.provenance)),
          effectiveImpact: effective
            ? compareUsPlanConfiguredFacts(
                parseUsPlanPublishedRow(effective).evidence.snapshot.configured,
                context.facts,
              )
            : null,
          publicationAvailability: this.publicationAvailability,
        });
      },
      { isolationLevel: "repeatable read" },
    );
  }

  async get(tenantId: string, actorUserId: string, rawId: unknown): Promise<UsPlanDetailResponse> {
    return this.db.transaction(
      async (tx) => {
        const context = await this.context(tx, tenantId, actorUserId);
        const id = parseMasterDataInput(platformUuidSchema, rawId);
        const table = schema.traceabilityPlanVersions;
        const [row] = await tx
          .select()
          .from(table)
          .where(and(eq(table.tenantId, tenantId), eq(table.id, id)))
          .limit(1);
        if (!row) throw new NotFoundException({ code: "us_plan_version_not_found" });
        if (row.status === "draft")
          return usPlanDetailResponseSchema.parse({
            ...parseUsPlanDraftRow(row),
            provenance: context.provenance,
          });
        const published = parseUsPlanPublishedRow(row);
        const { evidence } = published;
        return usPlanDetailResponseSchema.parse({
          ...this.item(row, context.provenance),
          schemaVersion: 1,
          createdBy: row.createdBy,
          approvedBy: published.approvedBy,
          changeSummary: published.changeSummary,
          snapshot: evidence.snapshot,
          factSources: {
            schemaVersion: 1,
            entries: evidence.factSources.entries.map((entry) => ({
              path: entry.path,
              source: publicSource(entry.source),
            })),
          },
          confirmations: {
            procedures: publicSource(evidence.confirmations.procedures),
            backupAndRecovery: publicSource(evidence.confirmations.backupAndRecovery),
            contact: publicSource(evidence.confirmations.contact),
            nonFarmScope: publicSource(evidence.confirmations.nonFarmScope),
          },
          comparisonAgainstCurrentConfiguredFacts: compareUsPlanConfiguredFacts(
            evidence.snapshot.configured,
            context.facts,
          ),
          retentionIndefiniteReason: published.retentionIndefiniteReason,
        });
      },
      { isolationLevel: "repeatable read" },
    );
  }
}
