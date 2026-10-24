import { z } from "zod";
import {
  channelSnapshotSchema,
  releaseIdentitySchema,
  releaseFileNameSchema,
  releaseSha256Schema,
  releaseVersionIdSchema,
  publicationRequestSchema,
  releaseFileSpecSchema,
} from "./release-catalog.js";
const signerImportSchema = z
  .object({
    identity: releaseIdentitySchema.refine((v) => v.product === "signer" && v.channel === "stable"),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    files: publicationRequestSchema.shape.files,
    evidence: z
      .object({
        kind: z.literal("signer"),
        manifestName: z.literal("latest.json"),
        evidenceName: z.literal("release-evidence.json"),
      })
      .strict(),
  })
  .strict();
export const historyPublicationRequestSchema = z.union([
  publicationRequestSchema,
  signerImportSchema,
]);
export type HistoryPublicationRequest = z.infer<typeof historyPublicationRequestSchema>;
const anchor = z
  .object({
    kind: z.enum([
      "github-current-listing",
      "github-release",
      "preserved-backup",
      "signing-record",
      "distribution-record",
    ]),
    sha256: releaseSha256Schema,
  })
  .strict();
const coverage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown") }).strict(),
  z.object({ kind: z.literal("complete"), evidenceSha256: releaseSha256Schema }).strict(),
  z
    .object({
      kind: z.literal("upper-bound"),
      evidenceSha256: releaseSha256Schema,
      upperBound: z.string().max(128),
    })
    .strict(),
]);
const object = releaseFileSpecSchema
  .extend({
    key: z
      .string()
      .max(1024)
      .regex(/^[0-9A-Za-z_./+-]+$/)
      .refine((v) => v.split("/").every((s) => s !== "" && s !== "." && s !== "..")),
    versionId: releaseVersionIdSchema,
  })
  .strict();
export const releaseHistoryEvidenceSchema = z
  .object({
    schema: z.literal(1),
    scope: channelSnapshotSchema.shape.identity,
    anchors: z.array(anchor).min(1).max(1000),
    coverage,
    releases: z
      .array(
        z
          .object({
            version: z.string().max(128),
            names: z.array(releaseFileNameSchema).max(16),
            evidenceSha256: releaseSha256Schema,
            publication: historyPublicationRequestSchema.nullable(),
            objects: z.array(object).max(16),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export type ReleaseHistoryEvidence = z.infer<typeof releaseHistoryEvidenceSchema>;
export type HistoryReservation =
  | { kind: "version"; version: string }
  | { kind: "path"; version: string; publicPath: string }
  | { kind: "range"; upperBound: string }
  | { kind: "closed" };
function invalid(): never {
  throw new Error("invalid or incomplete release history evidence");
}
/** Conservative occupied base: no prerelease on an already issued semver base can be reused. */
export function isReservedHistoryVersion(version: string, upperBound: string): boolean {
  const base = (v: string) => {
    if (v.length > 128 || !/^\d+\.\d+\.\d+(?:-beta\.[1-9]\d*)?$/.test(v)) invalid();
    return v.split("-")[0]?.split(".").map(BigInt) ?? invalid();
  };
  const a = base(version),
    b = base(upperBound);
  for (let i = 0; i < 3; i++) {
    const l = a[i],
      r = b[i];
    if (l === undefined || r === undefined) invalid();
    if (l !== r) return l < r;
  }
  return true;
}
/** Admission only: imports still require full pinned bytes and canonical product verification. */
export function deriveHistoryPlan(input: unknown) {
  const evidence = releaseHistoryEvidenceSchema.parse(input),
    scope = evidence.scope;
  if (scope.product === "signer" && scope.channel !== "stable") invalid();
  const anchors = new Map(evidence.anchors.map((a) => [a.sha256, a]));
  if (anchors.size !== evidence.anchors.length) invalid();
  const reservations: HistoryReservation[] = [],
    imports: ReleaseHistoryEvidence["releases"] = [],
    seen = new Set<string>();
  for (const release of evidence.releases) {
    const identity = releaseIdentitySchema.parse({ ...scope, version: release.version });
    if (seen.has(identity.version) || !anchors.has(release.evidenceSha256)) invalid();
    seen.add(identity.version);
    if (new Set(release.names.map((n) => n.toLowerCase())).size !== release.names.length) invalid();
    reservations.push({ kind: "version", version: release.version });
    for (const name of [...release.names].sort())
      reservations.push({
        kind: "path",
        version: release.version,
        publicPath: `/${scope.product}/${scope.channel}${scope.product === "standalone" ? "" : "/releases"}/${release.version}/${name}`,
      });
    if (release.publication) {
      const p = release.publication;
      if (
        p.identity.product !== scope.product ||
        p.identity.channel !== scope.channel ||
        p.identity.version !== release.version ||
        p.files.length !== release.names.length ||
        release.objects.length !== p.files.length
      )
        invalid();
      for (const spec of p.files) {
        const o = release.objects.filter((o) => o.name === spec.name);
        if (
          o.length !== 1 ||
          !release.names.includes(spec.name) ||
          !o[0]?.key.startsWith(`${scope.product}/`) ||
          o[0].sha256 !== spec.sha256 ||
          o[0].sizeBytes !== spec.sizeBytes ||
          o[0].contentType !== spec.contentType
        )
          invalid();
      }
      imports.push(release);
    } else if (release.objects.length) invalid();
  }
  const proof = evidence.coverage;
  if (proof.kind === "unknown") reservations.push({ kind: "closed" });
  else {
    const a = anchors.get(proof.evidenceSha256);
    if (!a || !["preserved-backup", "signing-record"].includes(a.kind)) invalid();
    if (proof.kind === "upper-bound") {
      releaseIdentitySchema.parse({ ...scope, version: proof.upperBound });
      if (evidence.releases.some((r) => !isReservedHistoryVersion(r.version, proof.upperBound)))
        invalid();
      reservations.push({ kind: "range", upperBound: proof.upperBound });
    }
  }
  return {
    schema: 1 as const,
    scope,
    historyComplete: proof.kind === "complete",
    writersMayEnable: false as const,
    reservations,
    imports,
  };
}

export function historyCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(historyCanonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${historyCanonical(v)}`)
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) invalid();
  return result;
}
