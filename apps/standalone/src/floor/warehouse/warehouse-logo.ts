import type { MonoBitmap } from "@markiro/domain";
import { z } from "zod";

import { shiftSnapshotOrganizationSchema } from "../../host/protocol.js";
import { logoFromWire } from "../../labels/logo.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";

/**
 * The organization this pairing's most recently opened shift froze (plan А4):
 * the only place a station learns the organization's print logo, since the
 * logo is in no reference copy and no change feed (А4-6). A snapshot of a host
 * before plan А4 has no `organization` and is passed over. Searches the
 * pairing's shifts through an index, then sorts the few it keeps (pinned in
 * `test/floor-schema.test.ts` and `src-tauri/tests/local_db.rs`).
 */
export const KNOWN_ORGANIZATION_SQL =
  "SELECT snapshot -> '$.organization' AS organization FROM floor_shifts " +
  "WHERE host_id = ? AND device_id = ? AND snapshot -> '$.organization' IS NOT NULL " +
  "ORDER BY opened_at DESC, id DESC LIMIT 1";

const organizationRow = z.object({ organization: z.string() });

/**
 * The organization's print logo as this station knows it now, for a
 * warehouse reprint (plan СКЛ × А4), which belongs to no shift of this
 * station: the logo of the newest shift snapshot that froze the organization.
 * `null` — no such snapshot, the organization froze no logo, or a logo this
 * build cannot read: the label then takes the bundled Markiro logo
 * (`renderLogoLabel`), as a shift's label does in the same case.
 */
export async function readKnownOrganizationLogo(
  local: LocalExecutor,
  pairing: Pairing,
): Promise<MonoBitmap | null> {
  const [row] = await local.query(
    KNOWN_ORGANIZATION_SQL,
    [pairing.hostId, pairing.deviceId],
    organizationRow,
  );
  if (row === undefined) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(row.organization);
  } catch {
    return null;
  }
  const organization = shiftSnapshotOrganizationSchema.safeParse(raw);
  if (!organization.success || organization.data.logo === null) return null;
  return logoFromWire(organization.data.logo);
}
