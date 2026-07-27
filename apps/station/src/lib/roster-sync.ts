import type { OperatorMirrorRecord } from "@markiro/db";
import type { StationClient } from "./api-client.js";
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
 * `replaceOperatorsMirror` is NOT wrapped in a transaction here: it does its
 * own individual statements (see its doc comment), because `tauri-plugin-sql`'s
 * pooled connections make a multi-call BEGIN/COMMIT unsound. If this sync fails
 * partway through, the mirror is left partially updated until the next
 * successful sync — same as the shift-bundle mirror.
 */
export async function syncOperatorRoster(
  client: Pick<StationClient, "get">,
  exec: SqlExecutor,
): Promise<void> {
  try {
    const { items } = await client.get<{ items: OperatorMirrorRecord[] }>("/station/operators");
    await replaceOperatorsMirror(exec, items);
  } catch (err) {
    console.error("station: operator roster sync failed", err);
  }
}
