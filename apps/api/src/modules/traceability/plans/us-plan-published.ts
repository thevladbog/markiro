import {
  canonicalExportDigest,
  type UsPlanApprovedEvidence,
  type UsPlanFactSource,
  type UsPlanSnapshot,
} from "@markiro/domain";
import { ServiceUnavailableException } from "@nestjs/common";
import { z } from "zod";
import type { UsPlanVersionRow } from "./us-plan-model";
import type { UsPlanArtifactEvidence } from "./us-plan-artifacts";
import { parseUsPlanHistoricalWorkflow } from "./us-plan-historical-policy";

const text = z.string().max(4096);
const nullableText = text.nullable();
const texts = z.array(text).max(50);
// Frozen schema v1, independent of the editable/current approval contract.
const sectionsV1Schema = z
  .object({
    recordMaintenance: z
      .object({
        systemOfRecord: text,
        formats: texts,
        recordLocations: texts,
        responsibleRoles: texts,
        backupAndRecovery: text,
        narrative: texts,
      })
      .strict(),
    ftlIdentification: z.object({ procedure: text, reviewCadence: text }).strict(),
    tlcAssignment: z.object({ procedure: text }).strict(),
    pointOfContact: z
      .object({ name: text, title: text, phone: text, email: nullableText })
      .strict(),
    farmActivity: z.object({ status: z.literal("no"), explanation: text }).strict(),
    reviewAndUpdate: z.object({ procedure: text }).strict(),
  })
  .strict();
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
    sections: sectionsV1Schema,
    provenance: z.enum(["operational", "trusted_synthetic"]),
    ftlReviewWorkflow: z.unknown().transform(parseUsPlanHistoricalWorkflow),
  })
  .strict();
const seedSchema = z
  .object({
    seedId: text.min(1),
    verifiedBy: text.min(1),
    verifiedAt: z.iso.datetime().refine((value) => new Date(value).toISOString() === value),
  })
  .strict();
const seedSourceSchema = z
  .object({ origin: z.literal("synthetic_fixture"), trustedSeed: seedSchema })
  .strict();

/** Validate the exhaustive v1 manifest against stored values and approval identity only. */
function historicalEvidenceV1(
  snapshot: UsPlanSnapshot,
  approvedBy: string,
  approvedAt: string,
  raw: unknown,
): UsPlanApprovedEvidence {
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
    .parse(raw);
  const confirmation: UsPlanApprovedEvidence["confirmations"]["procedures"] =
    snapshot.provenance === "trusted_synthetic"
      ? seedSourceSchema.parse(envelope.confirmations.procedures)
      : { origin: "operator_confirmed", actorId: approvedBy, confirmedAt: approvedAt };
  const entries: UsPlanApprovedEvidence["factSources"]["entries"] = [];
  const segment = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");
  function walk(value: unknown, path: string, source: UsPlanFactSource, policy = false): void {
    if (Array.isArray(value)) {
      entries.push({ path, source });
      value.forEach((item, index) => walk(item, `${path}/${index}`, source, policy));
    } else if (value !== null && typeof value === "object") {
      if (policy) entries.push({ path, source });
      Object.entries(value).forEach(([key, item]) =>
        walk(item, `${path}/${segment(key)}`, source, policy),
      );
    } else {
      entries.push({ path, source });
    }
  }
  const configured: UsPlanFactSource = { origin: "configured" };
  const { tlcSourceLocations, productProfiles, ...scalars } = snapshot.configured;
  walk(scalars, "/configured", configured);
  function collection<T>(items: T[], path: string, idOf: (item: T) => string): void {
    entries.push({ path, source: configured });
    let previous: string | undefined;
    for (const item of items) {
      const id = idOf(item);
      if (previous !== undefined && previous >= id)
        throw new TypeError("invalid_historical_fact_ids");
      previous = id;
      walk(item, `${path}/${segment(id)}`, configured);
    }
  }
  collection(tlcSourceLocations, "/configured/tlcSourceLocations", (item) => item.id);
  collection(productProfiles, "/configured/productProfiles", (item) => item.productId);
  walk(snapshot.sections, "/sections", confirmation);
  walk(
    snapshot.ftlReviewWorkflow,
    "/ftlReviewWorkflow",
    {
      origin: "application_policy",
      version: snapshot.ftlReviewWorkflow.version,
    },
    true,
  );
  entries.push({
    path: "/provenance",
    source: snapshot.provenance === "trusted_synthetic" ? confirmation : configured,
  });
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const evidence: UsPlanApprovedEvidence = {
    schemaVersion: 1,
    snapshot,
    factSources: { schemaVersion: 1, entries },
    confirmations: {
      procedures: confirmation,
      backupAndRecovery: confirmation,
      contact: confirmation,
      nonFarmScope: confirmation,
    },
  };
  if (canonicalExportDigest(envelope) !== canonicalExportDigest(evidence))
    throw new TypeError("invalid_historical_evidence");
  return evidence;
}

/** Frozen schema-v1 parser: no current configuration, wall clock or rendering is read. */
export function parseUsPlanPublishedRow(row: UsPlanVersionRow) {
  try {
    if (
      (row.status !== "effective" && row.status !== "superseded") ||
      !row.approvedBy ||
      !row.approvedBy.trim() ||
      !row.approvedAt ||
      row.schemaVersion !== 1 ||
      !row.idempotencyKeyHash ||
      !row.approvalRequestDigest
    )
      throw new Error("shape");
    const snapshot = snapshotSchema.parse(row.configSnapshot);
    if (
      canonicalExportDigest(snapshot) !== row.configDigest ||
      canonicalExportDigest(row.sections) !== canonicalExportDigest(snapshot.sections)
    )
      throw new Error("digest");
    const evidence = historicalEvidenceV1(
      snapshot,
      row.approvedBy,
      row.approvedAt.toISOString(),
      row.approvedEvidence,
    );
    const artifact: UsPlanArtifactEvidence = z
      .object({
        objectKey: z.string().max(200),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        byteSize: z.number().int().min(1).max(8_000_000),
        rendererVersion: z.enum(["us-plan-pdf-v1", "us-plan-pdf-v2"]),
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
