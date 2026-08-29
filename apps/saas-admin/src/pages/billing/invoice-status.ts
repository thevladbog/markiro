import type { StatusChipStatus } from "@markiro/ui";

import type { Invoice } from "./api.js";

const TONES: Record<Invoice["status"], StatusChipStatus> = {
  draft: "neutral",
  issued: "info",
  partially_paid: "warn",
  paid: "ok",
  cancelled: "error",
};

export function invoiceStatusTone(status: Invoice["status"]): StatusChipStatus {
  return TONES[status];
}
