import { DomainError } from "../errors.js";
import {
  warehouseEventSchema,
  type WarehouseReprintEvent,
  type WarehouseRerender,
} from "./contracts.js";

export type WarehouseReprintState =
  "prepared" | "sending" | "sent" | "verified" | "delivery_unknown" | "failed_before_send";
export interface WarehouseReprintProjection {
  jobId: string;
  sessionId: string;
  latestSequence: number;
  attemptId: string;
  attemptNo: number;
  attemptIds: string[];
  state: WarehouseReprintState;
  bytesDigest: string;
  payloadDigest: string;
  templateDigest: string;
  // Historical field name; replacements may now contain a RAW artifact as well.
  raster?: WarehouseRerender | undefined;
}
function invalid(): never {
  throw new DomainError("WAREHOUSE_REPRINT_TRANSITION", "Invalid warehouse print transition");
}

export function applyWarehouseReprintEvent(
  current: WarehouseReprintProjection | null,
  input: WarehouseReprintEvent,
): WarehouseReprintProjection {
  const event = warehouseEventSchema.parse(input);
  if (current === null) {
    if (event.kind !== "prepared" || event.sequence !== 1) invalid();
    return {
      jobId: event.jobId,
      sessionId: event.sessionId,
      latestSequence: 1,
      attemptId: event.attemptId,
      attemptNo: 1,
      attemptIds: [event.attemptId],
      state: "prepared",
      bytesDigest: event.bytesDigest,
      payloadDigest: event.payloadDigest,
      templateDigest: event.templateDigest,
      ...(event.printFormat === "mono-raster-v1"
        ? {
            raster: { bytesDigest: event.bytesDigest, dpi: event.dpi },
          }
        : {}),
    };
  }
  if (
    event.jobId !== current.jobId ||
    event.sessionId !== current.sessionId ||
    event.sequence !== current.latestSequence + 1
  )
    invalid();
  if (event.kind === "reprint_prepared") {
    if (
      !["sent", "verified", "delivery_unknown", "failed_before_send"].includes(current.state) ||
      event.attemptNo !== current.attemptNo + 1 ||
      current.attemptIds.includes(event.attemptId)
    )
      invalid();
    if (event.rerender) {
      if (current.state !== "failed_before_send") invalid();
      if (
        !event.rerender.printFormat &&
        !event.rerender.language &&
        (!current.raster || current.raster.language)
      )
        invalid();
    }
    return {
      ...current,
      ...(event.rerender
        ? { bytesDigest: event.rerender.bytesDigest, raster: event.rerender }
        : {}),
      latestSequence: event.sequence,
      attemptId: event.attemptId,
      attemptNo: event.attemptNo,
      attemptIds: [...current.attemptIds, event.attemptId],
      state: "prepared",
    };
  }
  if (event.attemptId !== current.attemptId) invalid();
  let state: WarehouseReprintState;
  switch (event.kind) {
    case "sending":
      if (current.state !== "prepared") invalid();
      state = "sending";
      break;
    case "sent":
      if (current.state !== "sending") invalid();
      state = "sent";
      break;
    case "delivery_unknown":
      if (current.state !== "sending") invalid();
      state = "delivery_unknown";
      break;
    case "failed_before_send":
      if (
        current.state !== "prepared" &&
        !(
          current.state === "sending" &&
          ["owner_changed", "driver_rejected"].includes(event.errorCode)
        )
      )
        invalid();
      state = "failed_before_send";
      break;
    case "verified":
      if (current.state !== "sent" && current.state !== "delivery_unknown") invalid();
      state = "verified";
      break;
    default:
      invalid();
  }
  return { ...current, latestSequence: event.sequence, state };
}
