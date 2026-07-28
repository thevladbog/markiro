import { randomBytes } from "node:crypto";
import { deriveDigestB64, formatPhc, PHC_ITERATIONS } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";

const SALT_BYTES = 16;

/**
 * The tenant's badge salt, minted on first use. Shared by every badge
 * verifier of the tenant so the kiosk can derive once per scan (see the
 * comment on `employeeBadgeSalts`). The upsert is atomic: two concurrent
 * callers converge on one salt rather than racing to overwrite.
 */
export async function getOrCreateBadgeSalt(db: Db, tenantId: string): Promise<string> {
  const candidate = randomBytes(SALT_BYTES).toString("base64");
  const [row] = await db
    .insert(schema.employeeBadgeSalts)
    .values({ tenantId, salt: candidate })
    .onConflictDoUpdate({
      target: schema.employeeBadgeSalts.tenantId,
      // A no-op update so the existing row is returned instead of nothing.
      set: { tenantId },
    })
    .returning({ salt: schema.employeeBadgeSalts.salt });
  return row!.salt;
}

/** A PHC verifier for `badgeCode` under the tenant's shared badge salt. */
export async function hashBadgeWithSalt(badgeCode: string, saltB64: string): Promise<string> {
  const digest = await deriveDigestB64(badgeCode, saltB64, PHC_ITERATIONS);
  return formatPhc(PHC_ITERATIONS, saltB64, digest);
}
