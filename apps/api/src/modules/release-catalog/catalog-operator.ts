import { createHash } from "node:crypto";
import { z } from "zod";
import {
  historyCanonical,
  releaseOperationIdSchema,
  releaseSha256Schema,
} from "@markiro/platform-contracts";
import type { Db } from "@markiro/db";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import type {
  PlatformAuditEvent,
  PlatformAuditService,
} from "../../platform-auth/platform-audit.service";
import { CatalogFault } from "./catalog-types";
import type { CatalogStore } from "./catalog-store";
import { scanRecovery, type RecoveryPlan } from "./catalog-recovery";
import { parseReceipt, digest, MAX_RECEIPT_BYTES } from "./catalog-receipts";
import { fenceCatalogRecovery, reconcileRecovery } from "./catalog-recovery-apply";
const positive = z.number().int().positive();
const evidenceSchema = z
  .object({
    schema: z.literal(1),
    bucket: z.literal("markiro-releases"),
    independentInventoryComplete: z.literal(true),
    independentReceipts: z
      .array(
        z
          .object({
            id: releaseOperationIdSchema,
            sha256: releaseSha256Schema,
            base64: z.string().max(Math.ceil(MAX_RECEIPT_BYTES / 3) * 4),
          })
          .strict(),
      )
      .max(10000),
    technicalKeys: z.array(z.string().max(200)).max(1000),
    limits: z
      .object({
        maxPages: positive.max(10000),
        maxRecords: positive.max(10000),
        maxBytes: positive.max(64 * 1024 * 1024),
        timeoutMs: positive.max(3600000),
      })
      .strict(),
  })
  .strict();
const admissionSchema = z
  .object({
    schema: z.literal(1),
    action: z.enum(["history", "recover"]),
    operationId: releaseOperationIdSchema,
    executorSha: z.string().regex(/^[a-f0-9]{40}$/),
    runId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    runAttempt: z.string().regex(/^[1-9][0-9]{0,5}$/),
    epoch: releaseOperationIdSchema,
    reviewedPlanSha256: releaseSha256Schema.optional(),
    evidenceSha256: releaseSha256Schema,
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type OperatorAdmission = z.infer<typeof admissionSchema>;
type Actor = Pick<PlatformAuditEvent, "actorPlatformUserId" | "actorRole" | "requestId">;
export interface OperatorGuards {
  admission: unknown;
  now(): number;
  /** Trusted protected-workflow adapter verifies the exact dispatch, reviewer and executor.
   * This is not an HTTP-supplied flag; the operator library is never an API route.
   */
  authorize(admission: OperatorAdmission): Promise<void>;
  /** Fresh stop/absence observation of API, publishers and old executor; no lock bypass. */
  assertFenced(): Promise<void>;
}
export function validateOperatorAdmission(
  input: unknown,
  action: OperatorAdmission["action"],
  sha256: string,
  now: number,
) {
  const a = admissionSchema.parse(input),
    expires = Date.parse(a.expiresAt);
  if (
    a.action !== action ||
    a.evidenceSha256 !== sha256 ||
    !Number.isFinite(now) ||
    expires <= now ||
    expires - now > 3600000
  )
    throw new CatalogFault("forbidden");
  return a;
}
export function recoveryEvidenceDigest(input: unknown) {
  return createHash("sha256")
    .update(historyCanonical(evidenceSchema.parse(input)))
    .digest("hex");
}
async function fresh(options: OperatorGuards, sha256: string) {
  const a = validateOperatorAdmission(options.admission, "recover", sha256, options.now());
  await options.authorize(a);
  await options.assertFenced();
  return a;
}
/** Exactly the Task4 scanner, with independent receipt bytes and protected fresh guards. */
export async function validateRecoveryEvidence(
  input: unknown,
  store: CatalogStore,
  options: OperatorGuards,
): Promise<RecoveryPlan> {
  const e = evidenceSchema.parse(input),
    sha256 = recoveryEvidenceDigest(e);
  await fresh(options, sha256);
  let total = 0;
  const inventory = e.independentReceipts.map((r) => {
    const b = Buffer.from(r.base64, "base64");
    total += b.length;
    if (
      total > e.limits.maxBytes ||
      b.toString("base64") !== r.base64 ||
      digest(b) !== r.sha256 ||
      parseReceipt(b).id !== r.id
    )
      throw new CatalogFault("not_ready");
    return { id: r.id, sha256: r.sha256 };
  });
  const plan = await scanRecovery(store, {
    ...e.limits,
    bucket: e.bucket,
    writersFenced: true,
    independentInventoryComplete: e.independentInventoryComplete,
    independentInventory: inventory,
    technicalKeys: e.technicalKeys,
  });
  await fresh(options, sha256);
  return plan;
}
export function recoveryPlanDigest(plan: RecoveryPlan) {
  // Enumeration order is not a semantic difference. Physical VersionIds are included.
  const byId = <T extends { operation: { id: string } }>(rows: T[]) =>
    [...rows].sort((a, b) => a.operation.id.localeCompare(b.operation.id));
  const normalized = {
    ...plan,
    receipts: byId(plan.receipts),
    reservedPublications: byId(plan.reservedPublications),
    reservations: byId(plan.reservations),
    publications: byId(plan.publications),
    channels: [...plan.channels].sort((a, b) =>
      historyCanonical(a.identity).localeCompare(historyCanonical(b.identity)),
    ),
  };
  return createHash("sha256").update(historyCanonical(normalized)).digest("hex");
}
/** Applying restores reservations only. No writer enable or inferred pointer restoration. */
export async function applyCatalogRecovery(
  input: unknown,
  store: CatalogStore,
  options: OperatorGuards & { db: Db; audit: Pick<PlatformAuditService, "record">; actor: Actor },
) {
  const sha256 = recoveryEvidenceDigest(input),
    admission = await fresh(options, sha256);
  // Persist fences before any scan that may fail. Missing S3/anchors must not reopen anything.
  await fenceCatalogRecovery(options.db, options.audit, options.actor);
  const [epoch] = await options.db
    .select()
    .from(schema.releaseCatalogEpochs)
    .where(eq(schema.releaseCatalogEpochs.id, admission.epoch));
  if (!epoch || epoch.enabled) throw new CatalogFault("not_ready");
  const plan = await validateRecoveryEvidence(input, store, options);
  if (
    !releaseSha256Schema.safeParse(admission.reviewedPlanSha256).success ||
    recoveryPlanDigest(plan) !== admission.reviewedPlanSha256
  )
    throw new CatalogFault("forbidden");
  await fresh(options, sha256);
  await reconcileRecovery(options.db, plan, options.audit, options.actor);
  return { planSha256: admission.reviewedPlanSha256, writersMayEnable: false as const };
}
