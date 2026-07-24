import type { StationClient } from "./api-client.js";
import { upsertBundle, type SqlExecutor, type StationBundle } from "./mirror.js";

/**
 * Downloads the full shift bundle (`GET /shifts/:id/bundle`) and mirrors it
 * into the local SQLite tables (`upsertBundle`) so the shift + product
 * (+ operators, mocked `[]` in 05a — see plan decision, server side is a
 * parallel 05b workstream) are available offline.
 *
 * Deliberately resilient: a download or mirror failure must never block the
 * operator from entering the shift they just opened/rejoined/started, so
 * errors are caught and logged, not rethrown. Factored out of `App.tsx` (its
 * only caller) so it is unit-testable with a mocked client and a
 * `node:sqlite` executor, without rendering React or faking Tauri IPC.
 */
export async function mirrorShiftBundle(
  client: Pick<StationClient, "get">,
  exec: SqlExecutor,
  shiftId: string,
): Promise<void> {
  try {
    const bundle = await client.get<StationBundle>(`/shifts/${shiftId}/bundle`);
    await upsertBundle(exec, bundle);
  } catch (err) {
    console.error("station: shift bundle download/mirror failed", err);
  }
}
