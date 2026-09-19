import type { TagPhase } from "@markiro/ui";

import type { Invoice } from "./api.js";

const PHASES: Record<Invoice["status"], TagPhase> = {
  draft: "draft",
  issued: "running",
  partially_paid: "attention",
  paid: "done",
  cancelled: "retired",
};

export function invoiceStatusPhase(status: Invoice["status"]): TagPhase {
  return PHASES[status];
}
