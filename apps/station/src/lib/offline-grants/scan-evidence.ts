import type { SqlExecutor } from "../mirror.js";
import { readStationSavedEvidence } from "./evidence-store.js";

export type StationEvidenceChannel = "items" | "boxes" | "pallets" | "productLabelEvents";
export async function readStationChannelEvidence(
  exec: SqlExecutor,
  channel: StationEvidenceChannel,
  identity: string | number,
  index: number,
) {
  let eventId: string | undefined;
  let recoveryOnly = false;
  if (channel === "items") {
    const [row] = await exec.all<{ event_id: string | null }>(
      `SELECT COALESCE(outbox.replay_event_id,evidence.event_id) event_id
       FROM outbox LEFT JOIN offline_grant_event_evidence evidence ON evidence.outbox_id=outbox.id
       WHERE outbox.id=?`,
      [identity],
    );
    eventId = row?.event_id ?? undefined;
  } else if (channel === "boxes" || channel === "pallets") {
    const table =
      channel === "boxes"
        ? "offline_grant_box_close_commands"
        : "offline_grant_pallet_close_commands";
    const field = channel === "boxes" ? "boxId" : "palletId";
    const [row] = await exec.all<{ event_id: string }>(
      `SELECT command.event_id FROM ${table} command JOIN offline_grant_decisions decision ON decision.event_id=command.event_id WHERE json_extract(command.payload_json,'$.${field}')=? AND json_extract(decision.decision_json,'$.allow')=1`,
      [identity],
    );
    eventId = row?.event_id;
  } else {
    const [event] = await exec.all<{
      original_event: string;
      kind: string;
      attempt_no: number | null;
    }>(
      `SELECT initial.event_id original_event,json_extract(event.event_json,'$.kind') kind,json_extract(event.event_json,'$.attemptNo') attempt_no
       FROM product_label_events event JOIN product_label_events initial
         ON initial.credential_ownership=event.credential_ownership AND initial.job_id=event.job_id
         AND json_extract(initial.event_json,'$.kind')='prepared' AND json_extract(initial.event_json,'$.attemptNo')=1
       WHERE event.event_id=?`,
      [identity],
    );
    eventId = event?.original_event ?? String(identity);
    recoveryOnly = event !== undefined && (event.kind !== "prepared" || event.attempt_no !== 1);
  }
  const type = {
    items: "shift.scan.v1",
    boxes: "shift.box.close.v1",
    pallets: "shift.pallet.close.v1",
    productLabelEvents: "shift.label.prepare.v1",
  }[channel];
  const saved = await readStationSavedEvidence(
    exec,
    eventId ? [{ eventId, pointer: `/${channel}/${index}#${type}` }] : [],
  );
  return recoveryOnly ? { negotiated: saved.negotiated, links: [] } : saved;
}
