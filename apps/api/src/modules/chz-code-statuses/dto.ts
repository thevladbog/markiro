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
 * group does not resolve them instantly -- `ChzCodeStatusIngestService`
 * re-resolves a null group the next time that exact code is scanned, or,
 * for a code with no scan to fall back on (e.g. one that only ever arrived
 * through a bootstrap inventory export), within the next daily full sweep
 * (see `sweepCodes`'s and `sweepSnapshotCodes`'s docs) -- but it is no
 * longer a dead end once either happens. Everything else here is
 * informational.
 */
export interface ChzCodeStatusSummaryDto {
  /** Every code the tenant's store knows about, refreshable or not. */
  total: number;
  /** `checkedAt` within the last 24 hours -- ЧЗ answered about the code recently. */
  refreshedLastDay: number;
  /** `chzProductGroupCode is null` -- unaskable; see the class doc above. */
  withoutProductGroup: number;
  /**
   * `max(checkedAt)` across the tenant's codes, or `null` if ЧЗ has never
   * answered about one. Named for exactly what it is -- the last time A CODE
   * was checked -- rather than "when the pass last ran": a healthy scheduler
   * pass over a tenant with nothing due does not advance any row's
   * `checkedAt`, so this can lag well behind the cron's own ten-minute
   * cadence while everything is working correctly. Do not read it as a
   * scheduler heartbeat.
   */
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
    lastCheckedAt: {
      type: "string",
      format: "date-time",
      nullable: true,
      description:
        "The most recent time ЧЗ answered about any of the tenant's codes -- not when the " +
        "refresh scheduler last ran. A pass with nothing due leaves this unchanged.",
    },
  },
};
