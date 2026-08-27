import { describe, expect, it } from "vitest";
import {
  dashboardOverviewOpenApiSchema,
  dashboardOverviewQuerySchema,
} from "../src/modules/dashboard/dto";

interface OpenApiSchema {
  type?: string;
  nullable?: boolean;
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  oneOf?: OpenApiSchema[];
  enum?: unknown[];
}

function schemaProperty(schema: OpenApiSchema, name: string): OpenApiSchema {
  const property = schema.properties?.[name];
  if (!property) throw new Error(`Missing OpenAPI property ${name}`);
  return property;
}

function expectClosedObject(schema: OpenApiSchema, fields: readonly string[]): void {
  expect(schema.type).toBe("object");
  expect(schema.additionalProperties).toBe(false);
  expect([...(schema.required ?? [])].sort()).toEqual([...fields].sort());
  expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...fields].sort());
}

describe("dashboard overview DTO contract", () => {
  it("defaults the allowed overview period to seven days", () => {
    expect(dashboardOverviewQuerySchema.parse({})).toEqual({ period: "7d" });
    expect(dashboardOverviewQuerySchema.parse({ period: "today" })).toEqual({ period: "today" });
    expect(dashboardOverviewQuerySchema.safeParse({ period: "year" }).success).toBe(false);
  });

  it("documents one closed response with isolated output modes and nullable rates", () => {
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
    expect(schemaProperty(overview, "metricVersion").enum).toEqual(["operations-dashboard-v1"]);

    const dynamics = schemaProperty(overview, "dynamics");
    expectClosedObject(dynamics, [
      "period",
      "grain",
      "currentWindow",
      "comparisonWindow",
      "buckets",
      "quality",
    ]);

    const bucket = schemaProperty(dynamics, "buckets").items;
    if (!bucket) throw new Error("Dashboard buckets must document array items");
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

    const activeShift = schemaProperty(overview, "activeShifts").items;
    if (!activeShift) throw new Error("Active shifts must document array items");
    const output = schemaProperty(activeShift, "output");
    expect(output.oneOf).toEqual([
      expect.objectContaining({
        additionalProperties: false,
        required: ["mode", "acceptedUnits"],
        properties: expect.objectContaining({ mode: { type: "string", enum: ["validation"] } }),
      }),
      expect.objectContaining({
        additionalProperties: false,
        required: ["mode", "closedBoxes", "containedUnits"],
        properties: expect.objectContaining({ mode: { type: "string", enum: ["aggregation"] } }),
      }),
    ]);
  });
});
