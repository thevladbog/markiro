import type { StationClient } from "./api-client.js";
import type { CredentialGeneration } from "./credential-recovery.js";
import { upsertBundle, type SqlExecutor, type StationBundle } from "./mirror.js";
import { addRange } from "./sscc-pool.js";

/**
 * Downloads the full shift bundle (`GET /shifts/:id/bundle`) and mirrors it
 * into the local SQLite tables (`upsertBundle`) so the shift + product
 * (+ operators, mocked `[]` in 05a — see plan decision, server side is a
 * parallel 05b workstream) are available offline.
 *
 * `bundle.sscc` (aggregation shifts only; null in validation mode, and null
 * when the server could not resolve this device an issuer prefix) is
 * likewise added to the local serial pool when present -- `addRange` is
 * idempotent (its primary key upserts a block already held, advancing its
 * cursor rather than regressing or duplicating it -- see its own doc
 * comment), so a replayed bundle download can never double the pool or
 * reissue a serial.
 *
 * CodeRabbit PR33 review, Finding 10: `addRange` runs BEFORE `upsertBundle`,
 * not after. `upsertBundle`'s very first statement publishes
 * `shift_mirror.issuer_prefix` (bundled into the same upsert as the rest of
 * the shift row), and `WorkScreen` enables the whole box UI the instant a
 * poll of `readShiftMirror` sees that column non-null -- it does not itself
 * check whether the local pool actually has anything in it. With the OLD
 * order (`upsertBundle` first, `addRange` last), a poll landing in the gap
 * between them -- while `upsertBundle`'s own product-mirror and full
 * multi-statement roster-publish steps were still running -- could enable
 * the box UI before the pool existed at all, and a scan arriving in that
 * window would auto-close as `no-serials` even though the range was about
 * to land. Worse, if `addRange` then failed, `issuer_prefix` stayed
 * committed and non-null with the pool never populated, until the next
 * bundle fetch tried again.
 *
 * Running `addRange` first makes `issuerPrefix != null`, as observed by ANY
 * concurrent reader, an invariant that always implies a usable pool: by the
 * time `upsertBundle` ever publishes that column, the range it names is
 * already there. `addRange` depends on nothing `upsertBundle` writes (it
 * touches only `sscc_pool`, keyed by issuer prefix, never shift/product
 * ids), so reordering the two costs nothing. If `addRange` itself fails, the
 * catch below skips `upsertBundle` entirely for this pass -- the same
 * "first failure stops the rest of this mirror attempt" behavior this
 * function already had (a failure partway through the OLD `upsertBundle`
 * already skipped `addRange` the same way), just with the one dependency
 * that actually matters now running first.
 *
 * Deliberately resilient: a download or mirror failure must never block the
 * operator from entering the shift they just opened/rejoined/started, so
 * errors are caught and logged, not rethrown. Factored out of `App.tsx` (its
 * only caller) so it is unit-testable with a mocked client and a
 * `node:sqlite` executor, without rendering React or faking Tauri IPC.
 */
const activeMirrors = new Set<Promise<boolean>>();

/** Waits for bundle downloads/writes that started before credential sealing. */
export async function waitForShiftBundleMirrors(): Promise<void> {
  await Promise.all([...activeMirrors]);
}

export function mirrorShiftBundle(
  client: Pick<StationClient, "get">,
  exec: SqlExecutor,
  shiftId: string,
  generation?: CredentialGeneration,
  isEntryCurrent: () => boolean = () => true,
): Promise<boolean> {
  const operation = (async () => {
    try {
      const bundle = await client.get<StationBundle>(`/shifts/${shiftId}/bundle`);
      if (generation?.sealed || !isEntryCurrent()) return false;
      if (bundle.sscc) {
        await addRange(exec, bundle.sscc);
      }
      if (generation?.sealed || !isEntryCurrent()) return false;
      await upsertBundle(exec, bundle);
      return true;
    } catch (err) {
      console.error("station: shift bundle download/mirror failed", err);
      return false;
    }
  })();
  activeMirrors.add(operation);
  return operation.finally(() => activeMirrors.delete(operation));
}
