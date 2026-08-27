import { describe, expect, it } from "vitest";
import {
  dashboardOverviewOpenApiSchema,
  dashboardOverviewQuerySchema,
  dashboardPeriods,
  type DashboardDataQualityDto,
} from "../src/modules/dashboard/dto";

interface OpenApiSchema {
  type?: "array" | "boolean" | "integer" | "number" | "object" | "string";
  nullable?: boolean;
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  oneOf?: OpenApiSchema[];
  enum?: unknown[];
}

type Equal<Actual, Expected> =
  (<Value>() => Value extends Actual ? 1 : 2) extends <Value>() => Value extends Expected ? 1 : 2
    ? true
    : false;
type Expect<Condition extends true> = Condition;
type DashboardSourcesAreExact = Expect<
  Equal<DashboardDataQualityDto["sources"], readonly ["code_registry", "boxes", "box_items"]>
>;

const dashboardSourcesAreExact: DashboardSourcesAreExact = true;
void dashboardSourcesAreExact;

function schemaProperty(schema: OpenApiSchema, name: string): OpenApiSchema {
  const property = schema.properties?.[name];
  if (!property) throw new Error(`Missing OpenAPI property ${name}`);
  return property;
}

function schemaItems(schema: OpenApiSchema): OpenApiSchema {
  if (!schema.items) throw new Error("Missing OpenAPI array item schema");
  return schema.items;
}

function expectClosedObject(
  schema: OpenApiSchema,
  fields: readonly string[],
  required: readonly string[] = fields,
): void {
  expect(schema.type).toBe("object");
  expect(schema.additionalProperties).toBe(false);
  expect([...(schema.required ?? [])].sort()).toEqual([...required].sort());
  expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...fields].sort());
}

function matchesOpenApiSchema(schema: OpenApiSchema, value: unknown): boolean {
  if (value === null) return schema.nullable === true;
  if (schema.oneOf) return schema.oneOf.filter((variant) => matchesOpenApiSchema(variant, value)).length === 1;
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) return false;

  switch (schema.type) {
    case "array":
      return Array.isArray(value) && !!schema.items && value.every((item) => matchesOpenApiSchema(schema.items!, item));
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "string":
      return typeof value === "string";
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      const properties = schema.properties ?? {};
      if ((schema.required ?? []).some((name) => !(name in record))) return false;
      if (schema.additionalProperties === false && Object.keys(record).some((name) => !(name in properties))) {
        return false;
      }
      return Object.entries(record).every(
        ([name, propertyValue]) => !properties[name] || matchesOpenApiSchema(properties[name], propertyValue),
      );
    }
    default:
      return false;
  }
}

const validWindow = {
  start: "2026-08-27T00:00:00.000Z",
  end: "2026-08-27T01:00:00.000Z",
  validation: { acceptedUnits: 12, shiftHours: 1, unitsPerShiftHour: 12 },
  aggregation: {
    closedBoxes: 3,
    containedUnits: 18,
    shiftHours: 1,
    boxesPerShiftHour: 3,
    containedUnitsPerShiftHour: 18,
  },
};

const validOverview = {
  generatedAt: "2026-08-27T01:00:00.000Z",
  timeZone: "Europe/Moscow",
  metricVersion: "operations-dashboard-v1",
  setup: { productCount: 2, shiftCount: 3, hasRunShift: true },
  verdict: { status: "under_control", reasons: [] },
  today: {
    validationAcceptedUnits: 12,
    aggregationClosedBoxes: 3,
    aggregationContainedUnits: 18,
    activeShiftCount: 1,
    includedClosedShiftCount: 1,
  },
  dynamics: {
    period: "7d",
    grain: "day",
    currentWindow: validWindow,
    comparisonWindow: validWindow,
    buckets: [{ ...validWindow, label: "27 Aug" }],
    quality: {
      status: "complete",
      reasons: [],
      activeShiftCount: 0,
      lateDataShiftCount: 0,
      sources: ["code_registry", "boxes", "box_items"],
    },
  },
  activeShifts: [
    {
      id: "11111111-1111-1111-8111-111111111111",
      number: "S-1",
      productName: "Product",
      lineName: "Line",
      openedAt: "2026-08-27T00:00:00.000Z",
      lateDataAt: null,
      output: { mode: "validation", acceptedUnits: 12 },
    },
  ],
};

describe("dashboard overview DTO contract", () => {
  it("defaults the allowed overview period to seven days and rejects unknown query keys", () => {
    expect(dashboardOverviewQuerySchema.parse({})).toEqual({ period: "7d" });
    expect(dashboardOverviewQuerySchema.parse({ period: "today" })).toEqual({ period: "today" });
    expect(dashboardOverviewQuerySchema.safeParse({ period: "year" }).success).toBe(false);
    expect(dashboardOverviewQuerySchema.safeParse({ period: "today", tenantId: "forged" }).success).toBe(false);
  });

  it("documents the exact enum sets", () => {
    const overview = dashboardOverviewOpenApiSchema as OpenApiSchema;
    expect(dashboardPeriods).toEqual(["today", "7d", "30d", "12w"]);
    expect(schemaProperty(overview, "metricVersion").enum).toEqual(["operations-dashboard-v1"]);
    expect(schemaProperty(schemaProperty(overview, "verdict"), "status").enum).toEqual([
      "under_control",
      "needs_attention",
      "critical",
    ]);

    const dynamics = schemaProperty(overview, "dynamics");
    expect(schemaProperty(dynamics, "period").enum).toEqual(["today", "7d", "30d", "12w"]);
    expect(schemaProperty(dynamics, "grain").enum).toEqual(["hour", "day", "week"]);

    const quality = schemaProperty(dynamics, "quality");
    expect(schemaProperty(quality, "status").enum).toEqual(["complete", "provisional", "insufficient"]);
    expect(schemaItems(schemaProperty(quality, "reasons")).enum).toEqual([
      "active_shifts",
      "late_data",
      "missing_shift_duration",
    ]);

    const reason = schemaItems(schemaProperty(schemaProperty(overview, "verdict"), "reasons"));
    expect(schemaProperty(reason, "code").enum).toEqual([
      "unreviewed_conflicts",
      "late_data",
      "missing_shift_duration",
    ]);
  });

  it("documents a completely closed overview response", () => {
    const overview = dashboardOverviewOpenApiSchema as OpenApiSchema;
    expectClosedObject(overview, [
      "generatedAt",
      "timeZone",
      "metricVersion",
      "setup",
      "verdict",
      "today",
      "dynamics",
      "activeShifts",
    ]);
    expectClosedObject(schemaProperty(overview, "setup"), ["productCount", "shiftCount", "hasRunShift"]);

    const verdict = schemaProperty(overview, "verdict");
    expectClosedObject(verdict, ["status", "reasons"]);
    expectClosedObject(schemaItems(schemaProperty(verdict, "reasons")), [
      "code",
      "severity",
      "count",
      "route",
      "affectedModes",
    ], ["code", "severity", "count"]);

    expectClosedObject(schemaProperty(overview, "today"), [
      "validationAcceptedUnits",
      "aggregationClosedBoxes",
      "aggregationContainedUnits",
      "activeShiftCount",
      "includedClosedShiftCount",
    ]);

    const dynamics = schemaProperty(overview, "dynamics");
    expectClosedObject(dynamics, [
      "period",
      "grain",
      "currentWindow",
      "comparisonWindow",
      "buckets",
      "quality",
    ]);

    for (const window of [
      schemaProperty(dynamics, "currentWindow"),
      schemaProperty(dynamics, "comparisonWindow"),
    ]) {
      expectClosedObject(window, ["start", "end", "validation", "aggregation"]);
      expectClosedObject(schemaProperty(window, "validation"), [
        "acceptedUnits",
        "shiftHours",
        "unitsPerShiftHour",
      ]);
      expectClosedObject(schemaProperty(window, "aggregation"), [
        "closedBoxes",
        "containedUnits",
        "shiftHours",
        "boxesPerShiftHour",
        "containedUnitsPerShiftHour",
      ]);
    }

    const bucket = schemaItems(schemaProperty(dynamics, "buckets"));
    expectClosedObject(bucket, ["start", "end", "label", "validation", "aggregation"]);
    const validation = schemaProperty(bucket, "validation");
    expectClosedObject(validation, ["acceptedUnits", "shiftHours", "unitsPerShiftHour"]);
    expect(schemaProperty(validation, "unitsPerShiftHour").nullable).toBe(true);
    const aggregation = schemaProperty(bucket, "aggregation");
    expectClosedObject(aggregation, [
      "closedBoxes",
      "containedUnits",
      "shiftHours",
      "boxesPerShiftHour",
      "containedUnitsPerShiftHour",
    ]);
    expect(schemaProperty(aggregation, "boxesPerShiftHour").nullable).toBe(true);
    expect(schemaProperty(aggregation, "containedUnitsPerShiftHour").nullable).toBe(true);

    const quality = schemaProperty(dynamics, "quality");
    expectClosedObject(quality, [
      "status",
      "reasons",
      "activeShiftCount",
      "lateDataShiftCount",
      "sources",
    ]);
    expect(schemaProperty(quality, "sources")).toMatchObject({
      minItems: 3,
      maxItems: 3,
      uniqueItems: true,
    });

    const activeShift = schemaItems(schemaProperty(overview, "activeShifts"));
    expectClosedObject(activeShift, [
      "id",
      "number",
      "productName",
      "lineName",
      "openedAt",
      "lateDataAt",
      "output",
    ]);
    const output = schemaProperty(activeShift, "output");
    expect(output.oneOf).toHaveLength(2);
    expectClosedObject(output.oneOf![0]!, ["mode", "acceptedUnits"]);
    expectClosedObject(output.oneOf![1]!, ["mode", "closedBoxes", "containedUnits"]);
  });

  it("rejects unknown and cross-mode response fields through the documented schema", () => {
    const overview = dashboardOverviewOpenApiSchema as OpenApiSchema;
    expect(matchesOpenApiSchema(overview, validOverview)).toBe(true);
    expect(matchesOpenApiSchema(overview, { ...validOverview, unexpected: true })).toBe(false);
    expect(
      matchesOpenApiSchema(overview, {
        ...validOverview,
        setup: { ...validOverview.setup, unexpected: true },
      }),
    ).toBe(false);
    expect(
      matchesOpenApiSchema(overview, {
        ...validOverview,
        activeShifts: [
          {
            ...validOverview.activeShifts[0],
            output: { mode: "validation", acceptedUnits: 12, closedBoxes: 3 },
          },
        ],
      }),
    ).toBe(false);
    expect(
      matchesOpenApiSchema(overview, {
        ...validOverview,
        activeShifts: [
          {
            ...validOverview.activeShifts[0],
            output: { mode: "aggregation", closedBoxes: 3, containedUnits: 18, acceptedUnits: 12 },
          },
        ],
      }),
    ).toBe(false);
  });
});
