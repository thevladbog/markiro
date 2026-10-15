import type { Db } from "@markiro/db";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";

const RETRYABLE_CONSTRAINTS = new Set([
  "standalone_sites_host_id_uq",
  "standalone_sites_tenant_request_uq",
  "standalone_license_issuances_tenant_site_request_uq",
  "standalone_support_diagnostics_blob_uq",
  "standalone_support_diagnostics_host_generated_uq",
  "standalone_support_token_aliases_pkey",
]);

/** The PostgreSQL SQLSTATE and constraint behind a driver or ORM error, if any. */
export function postgresFailure(error: unknown): {
  code: string | null;
  constraint: string | null;
} {
  let cursor: unknown = error;
  for (let depth = 0; depth < 5 && cursor !== null && typeof cursor === "object"; depth++) {
    const code = "code" in cursor && typeof cursor.code === "string" ? cursor.code : null;
    // A SQLSTATE, not a Node errno such as EPIPE (no SQLSTATE class starts with E).
    if (code !== null && /^[0-9A-Z]{5}$/u.test(code) && !/^E[A-Z]{4}$/u.test(code)) {
      const constraint =
        "constraint" in cursor && typeof cursor.constraint === "string" ? cursor.constraint : null;
      return { code, constraint };
    }
    cursor = "cause" in cursor ? cursor.cause : null;
  }
  return { code: null, constraint: null };
}

/**
 * REPEATABLE READ; a serialization failure or a lost idempotency race restarts the
 * whole operation (at most three attempts), and the restart replays the winner.
 */
export async function standaloneTransaction<T>(
  db: Db,
  action: (tx: SubscriptionTransaction) => Promise<T>,
  accessMode: "read write" | "read only" = "read write",
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(action, { isolationLevel: "repeatable read", accessMode });
    } catch (error) {
      const failure = postgresFailure(error);
      const retryable =
        failure.code === "40001" ||
        (failure.code === "23505" &&
          failure.constraint !== null &&
          RETRYABLE_CONSTRAINTS.has(failure.constraint));
      if (!retryable || attempt >= 2) throw error;
    }
  }
}
