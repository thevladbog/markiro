import { randomUUID } from "node:crypto";
import type { createUsProfileTestDatabase } from "./us-profile-database";

/** Valid draft-only shared-shell specimen, without bypassing any storage guard. */
export async function seedTransformationDraft(
  f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>,
  tenant: string,
  actor: string,
) {
  const id = randomUUID();
  const tx = await f.pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query(
      "INSERT INTO traceability_events(id,tenant_id,root_event_id,type,event_number,time_zone,created_by,updated_by) VALUES ($1,$2,$1,'transformation','TRN-26-0001','America/Chicago',$3,$3)",
      [id, tenant, actor],
    );
    await tx.query(
      "INSERT INTO transformation_event_roots(id,tenant_id,event_number,pending_draft_id) VALUES ($1,$2,'TRN-26-0001',$1)",
      [id, tenant],
    );
    await tx.query("COMMIT");
    return id;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
