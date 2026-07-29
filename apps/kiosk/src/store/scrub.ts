import { deriveDigestB64, PHC_ITERATIONS } from "@markiro/domain";
import { STORE_QUARANTINE, STORE_QUEUE, updateEach } from "./db.js";
import { listQuarantine, listQueue } from "./queue.js";

/**
 * The two stores that hold a whole order body, and therefore the badge it
 * names. Both are scrubbed, and the QUARANTINE is the one that matters most:
 * nothing prunes it, so a record parked there keeps whatever it holds for the
 * life of the device.
 */
const STORES = [STORE_QUEUE, STORE_QUARANTINE] as const;

/** A stored body as it may actually be on disk — today's shape, or a
 * pre-digest one. Neither store is read back through the writer's type. */
interface StoredBody {
  badgeCode?: unknown;
  badgeDigest?: unknown;
}

/** The plaintext badge code a stored record still carries, or null. */
function legacyBadgeCode(value: unknown): string | null {
  const body = (value as { body?: StoredBody } | null)?.body;
  if (typeof body?.badgeCode !== "string" || body.badgeCode === "") return null;
  return body.badgeCode;
}

/** The digest a stored record already carries, if it has one. */
function storedDigest(value: unknown): string | null {
  const body = (value as { body?: StoredBody } | null)?.body;
  return typeof body?.badgeDigest === "string" && body.badgeDigest !== "" ? body.badgeDigest : null;
}

/**
 * Removes the plaintext badge codes an EARLIER VERSION of this app persisted,
 * replacing each with the digest the server now takes.
 *
 * The order body is written to IndexedDB before any network attempt, so until
 * this runs a device that queued anything under the previous bundle is sitting
 * on reusable badge codes for every worker who submitted — the credential that
 * the rest of this app goes out of its way never to store (the bootstrap ships
 * verifiers, never codes). Draining the queue eventually clears its half; the
 * quarantine store's half never clears by itself.
 *
 * ONE DERIVATION PER DISTINCT CODE, not per record. PBKDF2 at 100000
 * iterations is ~50ms and a backlog is one or two workers' worth of orders, so
 * a queue of two hundred costs two derivations. They are all computed BEFORE
 * the rewrite because the rewrite runs inside an IndexedDB transaction, which
 * cannot be awaited across (see `updateEach`).
 *
 * NEVER REJECTS. This runs on the boot path, in front of the screen a worker
 * is standing at; a store that will not cooperate must leave the device
 * working and be retried on the next boot, not brick it. Resolves with how
 * many records were rewritten, which is what the tests assert on.
 *
 * Idempotent, and safe to call on a device that has nothing to migrate: a
 * record that carries no plaintext code is not rewritten at all.
 */
export async function scrubStoredBadgeCodes(badgeSalt: string): Promise<number> {
  try {
    // Pass 1 — find the work. Read through the same accessors the rest of the
    // app uses, then inspect the raw shape: these records predate the current
    // type, which is exactly why they need scrubbing.
    const stored: unknown[] = [...(await listQueue()), ...(await listQuarantine())];
    const codes = new Set<string>();
    let legacyRecords = 0;
    for (const record of stored) {
      const code = legacyBadgeCode(record);
      if (code === null) continue;
      legacyRecords += 1;
      // A record that somehow carries both needs no derivation — only the code
      // dropped, which pass 3 does either way.
      if (storedDigest(record) === null) codes.add(code);
    }
    // The overwhelmingly common case, on every boot after the first: nothing
    // to do, and no write transaction opened to discover it.
    if (legacyRecords === 0) return 0;

    // Pass 2 — derive, once per distinct code.
    const digests = new Map<string, string>();
    for (const code of codes) {
      digests.set(code, await deriveDigestB64(code, badgeSalt, PHC_ITERATIONS));
    }

    // Pass 3 — rewrite. Only records that still carry a code, and only with a
    // digest we actually have: one queued between passes 1 and 2 is left for
    // the next boot rather than guessed at.
    let rewritten = 0;
    for (const store of STORES) {
      rewritten += await updateEach(store, (value) => {
        const code = legacyBadgeCode(value);
        if (code === null) return null;
        const digest = storedDigest(value) ?? digests.get(code);
        if (digest === undefined) return null;
        const record = value as { body: Record<string, unknown> };
        const body: Record<string, unknown> = { ...record.body, badgeDigest: digest };
        delete body.badgeCode;
        return { ...record, body };
      });
    }
    return rewritten;
  } catch (err) {
    console.error("kiosk: the stored badge codes could not be scrubbed", err);
    return 0;
  }
}
