import type { OperatorMirrorRecord } from "@markiro/db";
import type { StationClient } from "./api-client.js";
import { credentialGenerationIsCurrent, type CredentialGeneration } from "./credential-recovery.js";
import { replaceOperatorsMirror, type SqlExecutor } from "./mirror.js";

/**
 * Downloads the tenant's operator roster (`GET /station/operators`) into the
 * local mirror. Runs during station initialization — right after the device has
 * a credential and BEFORE any operator can sign in — which is what makes a
 * freshly installed station usable (05a shipped with an empty mirror and no way
 * to fill it before login).
 *
 * Deliberately resilient: a device that is offline at startup must keep working
 * on the roster it already cached, so failures are logged, never rethrown. A
 * successful sync REPLACES the whole set, so an operator removed or deactivated
 * server-side stops authenticating offline.
 *
 * `replaceOperatorsMirror` publishes atomically (see its doc comment): a sync
 * that fails partway leaves the previously published roster active rather than
 * a partially updated one, so an interrupted sync can never widen offline
 * access. That write-side guarantee only holds end to end because
 * `readOperatorsMirror` is equally atomic on the read side — it resolves which
 * slot is active and reads that slot's rows in one statement, so a sign-in
 * can never straddle a publish and land on the slot that was active a moment
 * ago instead of the one that is active now.
 */
export async function syncOperatorRoster(
  client: Pick<StationClient, "get">,
  exec: SqlExecutor,
  generation?: CredentialGeneration,
): Promise<void> {
  try {
    const { items } = await client.get<{ items: OperatorMirrorRecord[] }>("/station/operators");
    await replaceOperatorsMirror(exec, items, {
      ...(generation ? { isCurrent: () => credentialGenerationIsCurrent(generation) } : {}),
    });
  } catch (err) {
    console.error("station: operator roster sync failed", err);
  }
}
