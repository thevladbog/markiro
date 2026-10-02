import {
  buildUsPlanSnapshot,
  buildUsPlanApprovedEvidence,
  buildUsPlanDraftFactSources,
  canonicalExportDigest,
} from "@markiro/domain";
import { usPlanSectionsSchema } from "@markiro/platform-contracts";
import { ServiceUnavailableException } from "@nestjs/common";
import { z } from "zod";
import type { UsPlanVersionRow } from "./us-plan-model";
import type { UsPlanArtifactEvidence } from "./us-plan-artifacts";

const text = z.string().max(4096);
const nullableText = text.nullable();
const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    configured: z
      .object({
        tenantName: text,
        profileCode: z.literal("US_FSMA204_PROCESSOR"),
        baselineVersion: text,
        timeZone: text,
        retentionYears: z.number().int().min(2),
        tlcSourceLocations: z
          .array(
            z
              .object({
                id: z.uuid(),
                description: z
                  .object({
                    partyId: z.uuid(),
                    businessName: text,
                    phoneNumber: nullableText,
                    addressKind: z.enum(["street", "coordinates"]),
                    streetAddress: nullableText,
                    latitude: nullableText,
                    longitude: nullableText,
                    city: nullableText,
                    stateOrRegion: nullableText,
                    zipOrPostalCode: nullableText,
                    countryCode: nullableText,
                  })
                  .strict(),
              })
              .strict(),
          )
          .max(200),
        productProfiles: z
          .array(
            z
              .object({
                productId: z.uuid(),
                revision: z.number().int().positive(),
                coverageStatus: text,
              })
              .strict(),
          )
          .max(200),
      })
      .strict(),
    sections: usPlanSectionsSchema,
    provenance: z.enum(["operational", "trusted_synthetic"]),
    ftlReviewWorkflow: z.unknown(),
  })
  .strict();
const seedSchema = z
  .object({ seedId: text, verifiedBy: text, verifiedAt: z.iso.datetime() })
  .strict();
const seedSourceSchema = z
  .object({ origin: z.literal("synthetic_fixture"), trustedSeed: seedSchema })
  .strict();

/** Frozen schema-v1 parser: no current configuration, wall clock or rendering is read. */
export function parseUsPlanPublishedRow(row: UsPlanVersionRow) {
  try {
    if (
      (row.status !== "effective" && row.status !== "superseded") ||
      !row.approvedBy ||
      !row.approvedAt ||
      row.schemaVersion !== 1 ||
      !row.idempotencyKeyHash ||
      !row.approvalRequestDigest
    )
      throw new Error("shape");
    const persisted = snapshotSchema.parse(row.configSnapshot);
    const snapshot = buildUsPlanSnapshot(
      persisted.configured,
      persisted.sections,
      persisted.provenance,
    );
    if (
      canonicalExportDigest(snapshot) !== canonicalExportDigest(persisted) ||
      canonicalExportDigest(snapshot) !== row.configDigest ||
      canonicalExportDigest(row.sections) !== canonicalExportDigest(snapshot.sections)
    )
      throw new Error("digest");
    const envelope = z
      .object({
        schemaVersion: z.literal(1),
        snapshot: z.unknown(),
        factSources: z.unknown(),
        confirmations: z
          .object({
            procedures: z.unknown(),
            backupAndRecovery: z.unknown(),
            contact: z.unknown(),
            nonFarmScope: z.unknown(),
          })
          .strict(),
      })
      .strict()
      .parse(row.approvedEvidence);
    const evidence = buildUsPlanApprovedEvidence(
      snapshot,
      buildUsPlanDraftFactSources(snapshot.configured, snapshot.sections),
      {
        kind: snapshot.provenance === "trusted_synthetic" ? "synthetic" : "operational",
        actorId: row.approvedBy,
        confirmedAt: row.approvedAt.toISOString(),
        confirmations: {
          procedures: true,
          backupAndRecovery: true,
          contact: true,
          nonFarmScope: true,
        },
        ...(snapshot.provenance === "trusted_synthetic"
          ? { trustedSeed: seedSourceSchema.parse(envelope.confirmations.procedures).trustedSeed }
          : {}),
      },
    );
    if (canonicalExportDigest(envelope) !== canonicalExportDigest(evidence))
      throw new Error("evidence");
    const artifact: UsPlanArtifactEvidence = z
      .object({
        objectKey: z.string().max(200),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        byteSize: z.number().int().min(1).max(8_000_000),
        rendererVersion: z.literal("us-plan-pdf-v1"),
        contentType: z.literal("application/pdf"),
      })
      .parse({
        objectKey: row.pdfObjectKey,
        sha256: row.pdfSha256,
        byteSize: row.pdfByteSize,
        rendererVersion: row.rendererVersion,
        contentType: "application/pdf",
      });
    const prefix = `us/plans/${row.tenantId}/${row.id}/`;
    if (
      !artifact.objectKey.startsWith(prefix) ||
      !artifact.objectKey.endsWith(".pdf") ||
      !z.uuid().safeParse(artifact.objectKey.slice(prefix.length, -4)).success
    )
      throw new Error("scope");
    return {
      id: row.id,
      versionNumber: row.versionNumber,
      status: row.status,
      draftRevision: row.draftRevision,
      approvedBy: row.approvedBy,
      approvedAt: row.approvedAt.toISOString(),
      changeSummary: row.changeSummary,
      configDigest: row.configDigest,
      evidence,
      artifact,
      supersededAt: row.supersededAt?.toISOString() ?? null,
      retainThrough: row.retainThrough,
      retentionIndefiniteReason: row.retentionIndefiniteReason,
    };
  } catch {
    throw new ServiceUnavailableException({ code: "us_plan_stored_published_invalid" });
  }
}
