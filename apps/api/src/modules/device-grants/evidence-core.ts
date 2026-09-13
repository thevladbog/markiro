import { createHash } from "node:crypto";
import {
  productLabelValueDigest,
  taskGrantSchema,
  type GrantOwner,
  type TaskGrant,
} from "@markiro/domain";

export function evidenceIdentity(
  owner: Pick<GrantOwner, "tenantId" | "deviceId" | "kind">,
  operation: string,
  batchId: string,
): string {
  return productLabelValueDigest([owner.tenantId, owner.kind, owner.deviceId, operation, batchId]);
}
/** Sanitized recovery copy: credentials are excluded, manufacturing strings are untouched. */
export function sanitizeEvidencePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const retained = { ...payload };
  for (const key of ["badgeCode", "admissionProof"]) {
    if (typeof retained[key] === "string") {
      retained[`${key}Hash`] = createHash("sha256").update(retained[key]).digest("hex");
      delete retained[key];
    }
  }
  return retained;
}
/**
 * A database issuance is the authority for original signed bytes, including old
 * retired keys. Parsing alone never authenticates a grant. Exact bytes must match
 * an immutable issuance fetched under the authenticated tenant and device scope.
 */
export function retainedGrant(compact: string, issuedCompact: string): TaskGrant | null {
  if (compact !== issuedCompact) return null;
  try {
    const parts = compact.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    const parsed = taskGrantSchema.safeParse(
      JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
