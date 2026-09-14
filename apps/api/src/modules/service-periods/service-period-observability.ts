import { Injectable, Logger } from "@nestjs/common";
import type { InvoiceApplicationResultSource } from "@markiro/platform-contracts";

export type ServicePeriodCreatedEvent = {
  event: "period_created";
  invoiceId: string;
  invoiceLineId: string;
  periodId: string;
  catalogItemId: string;
  startsAt: string;
  endsAt: string;
};

@Injectable()
export class ServicePeriodObservability {
  readonly #logger = new Logger(ServicePeriodObservability.name);

  recordCommitted(result: InvoiceApplicationResultSource | undefined): void {
    if (!result) return;
    for (const line of result.results) {
      if (line.status !== "applied" || !isServicePeriodResult(line.result)) continue;
      this.periodCreated({
        event: "period_created",
        invoiceId: result.invoiceId,
        invoiceLineId: line.lineId,
        periodId: line.result.id,
        catalogItemId: line.result.catalogItemId,
        startsAt: line.result.startsAt,
        endsAt: line.result.endsAt,
      });
    }
  }

  periodCreated(event: ServicePeriodCreatedEvent): void {
    try {
      this.#logger.log(JSON.stringify(event));
    } catch {
      // Operational logging must not alter a committed commercial operation.
    }
  }
}

function isServicePeriodResult(value: unknown): value is {
  kind: "service_period";
  id: string;
  catalogItemId: string;
  startsAt: string;
  endsAt: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "service_period" &&
    "id" in value &&
    typeof value.id === "string" &&
    "catalogItemId" in value &&
    typeof value.catalogItemId === "string" &&
    "startsAt" in value &&
    typeof value.startsAt === "string" &&
    "endsAt" in value &&
    typeof value.endsAt === "string"
  );
}
