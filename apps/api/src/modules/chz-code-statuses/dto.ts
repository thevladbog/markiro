import type { SchemaObject } from "@nestjs/swagger";

/**
 * The freshness line an operator reads on the `chestny_znak` channel's own
 * panel (Task 6, docs/design-briefs -- "is this working, and is the data I am
 * about to rely on fresh"). One row of `chz_code_statuses` per known marking
 * code, tenant-wide -- see that table's own doc, packages/db/src/schema/chz.ts.
 *
 * `withoutProductGroup` is the one number here the operator can act on: those
 * codes are unaskable until their product has a ЧЗ group, because
 * `cises/info` takes the group as a query parameter. Giving the product a
 * group does not resolve them immediately -- `ChzCodeStatusIngestService`
 * only re-resolves a null group the next time that exact code is ingested
 * again (see `insertStatuses`'s doc), typically the next time it is scanned
 * -- but it is no longer a dead end once that happens. Everything else here
 * is informational.
 */
export interface ChzCodeStatusSummaryDto {
  /** Every code the tenant's store knows about, refreshable or not. */
  total: number;
  /** `checkedAt` within the last 24 hours -- ЧЗ answered about the code recently. */
  refreshedLastDay: number;
  /** `chzProductGroupCode is null` -- unaskable; see the class doc above. */
  withoutProductGroup: number;
  /** `max(checkedAt)` across the tenant, or `null` if no pass has ever checked one. */
  lastCheckedAt: string | null;
}

export const chzCodeStatusSummaryOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["total", "refreshedLastDay", "withoutProductGroup", "lastCheckedAt"],
  properties: {
    total: { type: "integer", minimum: 0 },
    refreshedLastDay: { type: "integer", minimum: 0 },
    withoutProductGroup: { type: "integer", minimum: 0 },
    lastCheckedAt: { type: "string", format: "date-time", nullable: true },
  },
};
