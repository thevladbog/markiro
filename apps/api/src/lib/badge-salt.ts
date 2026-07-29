import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
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

/**
 * The tenant's badge salt if it has one, WITHOUT minting one.
 *
 * For read paths that resolve a badge rather than provision hashing — chiefly
 * `POST /kiosk/orders`, which runs per order and has no business writing a row
 * to answer a lookup. `null` is the right answer rather than a fresh salt: a
 * tenant with no salt row has no badge verifiers either, so nothing could have
 * matched under a salt minted here anyway.
 */
export async function readBadgeSalt(db: Db, tenantId: string): Promise<string | null> {
  const [row] = await db
    .select({ salt: schema.employeeBadgeSalts.salt })
    .from(schema.employeeBadgeSalts)
    .where(eq(schema.employeeBadgeSalts.tenantId, tenantId));
  return row?.salt ?? null;
}

/** A PHC verifier for `badgeCode` under the tenant's shared badge salt. */
export async function hashBadgeWithSalt(badgeCode: string, saltB64: string): Promise<string> {
  const digest = await deriveDigestB64(badgeCode, saltB64, PHC_ITERATIONS);
  return formatPhc(PHC_ITERATIONS, saltB64, digest);
}
