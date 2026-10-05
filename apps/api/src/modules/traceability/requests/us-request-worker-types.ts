import { createHash } from "node:crypto";
import type { schema } from "@markiro/db";
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { z } from "zod";
import { assertUsRequestReportModel } from "./us-request-package-inputs";
import { parseUsRequestManifest, type UsRequestManifestV1 } from "./us-request-package-manifest";
import {
  US_REQUEST_PACKAGE_LIMITS as limits,
  US_REQUEST_PACKAGE_VERSION,
  US_REQUEST_REPORT_PDF_VERSION,
  type UsRequestReportModel,
  type UsRequestFileDescriptor,
  type UsRequestPackageName,
} from "./us-request-package-types";
import { stableStringify } from "./us-request-snapshot";

export type UsWorkerScope = Readonly<{ tenantId: string; runId: string }>;
export type UsWorkerLease = Readonly<
  UsWorkerScope & {
    attemptId: string;
    attemptNumber: number;
    cycle: number;
    token: string;
    startedAt: string;
    expiresAt: string;
    deadlineAt: string;
  }
>;
export type UsWorkerArtifactName = Exclude<UsRequestPackageName, "SHA256SUMS">;
export type UsWorkerArtifactKind =
  "xlsx" | "plan_pdf" | "validation_report" | "request_report" | "manifest" | "package_zip";
export type UsWorkerObjectEvidence = Readonly<
  UsWorkerScope & {
    id: string;
    attemptId: string;
    name: UsWorkerArtifactName;
    kind: UsWorkerArtifactKind;
    objectKey: string;
    mediaType: string;
    byteSize: number;
    sha256: string;
  }
>;
export type UsWorkerCheckpoint = Readonly<{
  model: UsRequestReportModel;
  modelDigest: string;
  executionDigest: string;
  packageVersion: string;
  reportVersion: string;
}>;
export type UsWorkerPackageExpectation = Readonly<{
  manifest: UsRequestManifestV1;
  entries: readonly UsRequestFileDescriptor[];
  zip: UsRequestFileDescriptor<"package.zip">;
}>;
export type UsWorkerRunState = Readonly<{
  run: typeof schema.traceExportRuns.$inferSelect;
  attempts: readonly (typeof schema.traceExportAttempts.$inferSelect)[];
  checkpoint: UsWorkerCheckpoint | null;
  expectation: UsWorkerPackageExpectation | null;
  artifacts: readonly (typeof schema.traceExportArtifacts.$inferSelect)[];
}>;
export const US_REQUEST_WORKER_POLICY = Object.freeze({
  leaseMs: 120_000,
  renewMs: 30_000,
  deadlineMs: 300_000,
  attemptsPerCycle: 3,
  retryDelaysMs: [10_000, 60_000] as const,
});

export const US_REQUEST_WORKER_FAILURE_CODES = [
  "insufficient_permission",
  "traceability_profile_required",
  "traceability_profile_invalid",
  "us_request_profile_unsupported",
  "us_request_run_stored_invalid",
  "us_request_package_refreeze_required",
  "us_request_payload_evidence_mismatch",
  "us_request_payload_size_limit",
  "us_request_payload_workbook_unavailable",
  "us_request_payload_render_failed",
  "us_request_plan_read_failed",
  "us_request_package_inputs_invalid",
  "us_request_package_context_invalid",
  "us_request_package_model_invalid",
  "us_request_package_size_limit",
  "us_request_package_manifest_invalid",
  "us_request_package_archive_invalid",
  "us_request_report_render_failed",
  "us_request_worker_lease_lost",
  "us_request_worker_deadline_exceeded",
  "us_request_worker_retry_limit",
  "us_request_worker_checkpoint_mismatch",
  "us_request_worker_execution_invalid",
  "us_request_worker_stored_invalid",
  "us_request_worker_retry_conflict",
  "us_request_worker_unknown_failure",
  "us_request_worker_database_unavailable",
  "us_request_worker_database_retryable",
  "us_request_package_storage_configuration_invalid",
  "us_request_package_storage_operational_verification_required",
  "us_request_package_storage_transport_failed",
  "us_request_package_storage_timeout",
  "us_request_package_storage_evidence_invalid",
  "us_request_package_storage_scope_invalid",
  "us_request_package_storage_collision",
  "us_request_package_storage_checksum_mismatch",
  "us_request_package_storage_read_failed",
  "us_request_package_storage_delete_failed",
] as const;
export const usWorkerFailureCodeSchema = z.enum(US_REQUEST_WORKER_FAILURE_CODES);
export type UsWorkerFailureCode = z.infer<typeof usWorkerFailureCodeSchema>;
export type UsWorkerFailure = Readonly<{ code: UsWorkerFailureCode; retryable: boolean }>;
export type UsWorkerRetryBody = Readonly<{
  expectedLifecycleVersion: number;
  reason: string;
  idempotencyKey: string;
}>;
export type UsWorkerRetryReceipt = Readonly<
  UsWorkerScope & {
    cycle: number;
    lifecycleVersion: number;
    requestedBy: string;
    idempotencyKey: string;
  }
>;

export function isUsWorkerTransientCode(code: UsWorkerFailureCode): boolean {
  return (
    code === "us_request_worker_database_unavailable" ||
    code === "us_request_worker_database_retryable" ||
    code === "us_request_package_storage_transport_failed" ||
    code === "us_request_package_storage_timeout"
  );
}
export function parseUsWorkerFailure(value: unknown): UsWorkerFailure {
  try {
    plainJson(value);
    const result = z
      .object({ code: usWorkerFailureCodeSchema, retryable: z.boolean() })
      .strict()
      .parse(value);
    if (result.retryable !== isUsWorkerTransientCode(result.code)) throw invalid();
    return result;
  } catch {
    throw new ServiceUnavailableException({ code: "us_request_worker_stored_invalid" });
  }
}
export function parseUsWorkerRetryBody(value: unknown): UsWorkerRetryBody {
  try {
    plainJson(value);
    return z
      .object({
        expectedLifecycleVersion: positive,
        reason: z
          .string()
          .min(3)
          .max(2000)
          .refine((s) => s.trim().length >= 3),
        idempotencyKey: uuid,
      })
      .strict()
      .parse(value);
  } catch {
    throw new BadRequestException({ code: "us_request_worker_retry_conflict" });
  }
}
export function parseUsWorkerRetryReceipt(value: unknown): UsWorkerRetryReceipt {
  return parse(value, (v) =>
    scopeSchema
      .extend({
        cycle: positive.refine((n) => n > 1),
        lifecycleVersion: positive,
        requestedBy: z.string().min(1),
        idempotencyKey: uuid,
      })
      .strict()
      .parse(v),
  );
}

const invalid = () =>
  new ServiceUnavailableException({ code: "us_request_worker_evidence_invalid" });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const positive = z.number().refine(Number.isSafeInteger).positive();
const instant = z.string().refine((value) => {
  const n = Date.parse(value);
  return Number.isSafeInteger(n) && new Date(n).toISOString() === value;
});
const scopeSchema = z.object({ tenantId: uuid, runId: uuid }).strict();
const leaseSchema = scopeSchema
  .extend({
    attemptId: uuid,
    attemptNumber: positive,
    cycle: positive,
    token: uuid,
    startedAt: instant,
    expiresAt: instant,
    deadlineAt: instant,
  })
  .strict();
const mappings = {
  "records.xlsx": {
    kind: "xlsx",
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    max: limits.workbook,
  },
  "plan.pdf": { kind: "plan_pdf", mediaType: "application/pdf", max: limits.plan },
  "validation.json": {
    kind: "validation_report",
    mediaType: "application/json",
    max: limits.validation,
  },
  "request-report.pdf": {
    kind: "request_report",
    mediaType: "application/pdf",
    max: limits.report,
  },
  "manifest.json": { kind: "manifest", mediaType: "application/json", max: limits.manifest },
  "package.zip": { kind: "package_zip", mediaType: "application/zip", max: limits.zip },
} as const;
const descriptorSchema = z
  .object({
    name: z.enum([
      "records.xlsx",
      "plan.pdf",
      "validation.json",
      "request-report.pdf",
      "manifest.json",
      "SHA256SUMS",
      "package.zip",
    ]),
    mediaType: z.string(),
    byteSize: positive,
    sha256: digest,
  })
  .strict()
  .refine((file) =>
    file.name === "SHA256SUMS"
      ? file.mediaType === "text/plain" && file.byteSize <= limits.sums
      : file.mediaType === mappings[file.name].mediaType &&
        file.byteSize <= mappings[file.name].max,
  );
const objectSchema = scopeSchema
  .extend({
    id: uuid,
    attemptId: uuid,
    name: z.enum([
      "records.xlsx",
      "plan.pdf",
      "validation.json",
      "request-report.pdf",
      "manifest.json",
      "package.zip",
    ]),
    kind: z.enum([
      "xlsx",
      "plan_pdf",
      "validation_report",
      "request_report",
      "manifest",
      "package_zip",
    ]),
    objectKey: z.string(),
    mediaType: z.string(),
    byteSize: positive,
    sha256: digest,
  })
  .strict();

/** Refuse executable/non-JSON values before any parser can read a property. */
function plainJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || seen.has(value)) throw invalid();
  seen.add(value);
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw invalid();
    if (array && key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)) throw invalid();
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !("value" in descriptor) ||
      (!descriptor.enumerable && !(array && key === "length"))
    )
      throw invalid();
    if (!(array && key === "length")) plainJson(descriptor.value, seen);
  }
  if (array && Object.keys(value).length !== value.length) throw invalid();
  seen.delete(value);
}
function parse<T>(value: unknown, read: (value: unknown) => T): T {
  try {
    plainJson(value);
    return read(value);
  } catch {
    throw invalid();
  }
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function parseUsWorkerScope(value: unknown): UsWorkerScope {
  return parse(value, (v) => scopeSchema.parse(v));
}
export function parseUsWorkerLease(value: unknown): UsWorkerLease {
  return parse(value, (v) => {
    const lease = leaseSchema.parse(v),
      start = Date.parse(lease.startedAt),
      end = Date.parse(lease.expiresAt),
      deadline = Date.parse(lease.deadlineAt);
    if (end <= start || end > deadline || deadline - start !== US_REQUEST_WORKER_POLICY.deadlineMs)
      throw invalid();
    return lease;
  });
}
export function parseUsWorkerObjectEvidence(value: unknown): UsWorkerObjectEvidence {
  return parse(value, (v) => {
    const evidence = objectSchema.parse(v),
      rule = mappings[evidence.name];
    if (
      evidence.kind !== rule.kind ||
      evidence.mediaType !== rule.mediaType ||
      evidence.byteSize > rule.max ||
      evidence.objectKey !==
        `us/requests/${evidence.tenantId}/${evidence.runId}/${evidence.attemptId}/${evidence.name}`
    )
      throw invalid();
    return evidence;
  });
}
export function usWorkerByteSizeFromDb(value: unknown): number {
  if (typeof value !== "bigint" || value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw invalid();
  return Number(value);
}
export function parseUsWorkerCheckpoint(value: unknown): UsWorkerCheckpoint {
  return parse(value, (v) => {
    const parsed = z
      .object({
        model: z.unknown(),
        modelDigest: digest,
        executionDigest: digest,
        packageVersion: z.literal(US_REQUEST_PACKAGE_VERSION),
        reportVersion: z.literal(US_REQUEST_REPORT_PDF_VERSION),
      })
      .strict()
      .parse(v);
    const model = parsed.model;
    assertUsRequestReportModel(model);
    if (hash(Buffer.from(stableStringify(model))) !== parsed.modelDigest) throw invalid();
    return { ...parsed, model: structuredClone(model) };
  });
}
export function parseUsWorkerPackageExpectation(value: unknown): UsWorkerPackageExpectation {
  return parse(value, (v) => {
    const parsed = z
      .object({
        manifest: z.unknown(),
        entries: z.array(descriptorSchema).min(4).max(limits.entries),
        zip: descriptorSchema.refine((d) => d.name === "package.zip"),
      })
      .strict()
      .parse(v);
    const manifest = parseUsRequestManifest(parsed.manifest),
      bytes = Buffer.from(stableStringify(manifest));
    const manifestDescriptor = {
      name: "manifest.json",
      mediaType: "application/json",
      byteSize: bytes.length,
      sha256: hash(bytes),
    };
    const sums = Buffer.from(
      [...manifest.files, manifestDescriptor]
        .map((file) => `${file.sha256}  ${file.name}\n`)
        .join(""),
    );
    const expected = [
      ...manifest.files,
      manifestDescriptor,
      { name: "SHA256SUMS", mediaType: "text/plain", byteSize: sums.length, sha256: hash(sums) },
    ];
    if (
      stableStringify(expected) !== stableStringify(parsed.entries) ||
      parsed.entries.reduce((sum, e) => sum + e.byteSize, 0) > limits.entriesTotal ||
      parsed.zip.name !== "package.zip"
    )
      throw invalid();
    return { manifest, entries: parsed.entries, zip: { ...parsed.zip, name: "package.zip" } };
  });
}
