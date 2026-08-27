import { z } from "zod";

export const dashboardPeriods = ["today", "7d", "30d", "12w"] as const;
export type DashboardPeriod = (typeof dashboardPeriods)[number];

export type DashboardVerdict = "under_control" | "needs_attention" | "critical";
export type DashboardReasonCode = "unreviewed_conflicts" | "late_data" | "missing_shift_duration";
export type DashboardQualityStatus = "complete" | "provisional" | "insufficient";
export type DashboardQualityReasonCode = "active_shifts" | "late_data" | "missing_shift_duration";
export type DashboardGrain = "hour" | "day" | "week";
export type DashboardMode = "validation" | "aggregation";
export type DashboardDataSource = "code_registry" | "boxes" | "box_items";

export const dashboardOverviewQuerySchema = z.object({
  period: z.enum(dashboardPeriods).default("7d"),
});
export type DashboardOverviewQueryDto = z.infer<typeof dashboardOverviewQuerySchema>;

export interface DashboardValidationMetricsDto {
  acceptedUnits: number;
  shiftHours: number;
  unitsPerShiftHour: number | null;
}

export interface DashboardAggregationMetricsDto {
  closedBoxes: number;
  containedUnits: number;
  shiftHours: number;
  boxesPerShiftHour: number | null;
  containedUnitsPerShiftHour: number | null;
}

export interface DashboardWindowDto {
  start: string;
  end: string;
  validation: DashboardValidationMetricsDto;
  aggregation: DashboardAggregationMetricsDto;
}

export interface DashboardBucketDto extends DashboardWindowDto {
  label: string;
}

export type DashboardShiftOutputDto =
  | { mode: "validation"; acceptedUnits: number }
  | { mode: "aggregation"; closedBoxes: number; containedUnits: number };

export interface DashboardActiveShiftDto {
  id: string;
  number: string;
  productName: string | null;
  lineName: string | null;
  openedAt: string;
  lateDataAt: string | null;
  output: DashboardShiftOutputDto;
}

export interface DashboardReasonDto {
  code: DashboardReasonCode;
  severity: Exclude<DashboardVerdict, "under_control">;
  count: number;
  route?: string;
  affectedModes?: DashboardMode[];
}

export interface DashboardDataQualityDto {
  status: DashboardQualityStatus;
  reasons: DashboardQualityReasonCode[];
  activeShiftCount: number;
  lateDataShiftCount: number;
  sources: DashboardDataSource[];
}

export interface DashboardOverviewDto {
  generatedAt: string;
  timeZone: string;
  metricVersion: "operations-dashboard-v1";
  setup: {
    productCount: number;
    shiftCount: number;
    hasRunShift: boolean;
  };
  verdict: {
    status: DashboardVerdict;
    reasons: DashboardReasonDto[];
  };
  today: {
    validationAcceptedUnits: number;
    aggregationClosedBoxes: number;
    aggregationContainedUnits: number;
    activeShiftCount: number;
    includedClosedShiftCount: number;
  };
  dynamics: {
    period: DashboardPeriod;
    grain: DashboardGrain;
    currentWindow: DashboardWindowDto;
    comparisonWindow: DashboardWindowDto;
    buckets: DashboardBucketDto[];
    quality: DashboardDataQualityDto;
  };
  activeShifts: DashboardActiveShiftDto[];
}

const validationMetricsOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["acceptedUnits", "shiftHours", "unitsPerShiftHour"],
  properties: {
    acceptedUnits: { type: "integer", minimum: 0 },
    shiftHours: { type: "number", minimum: 0, description: "Elapsed shift hours" },
    unitsPerShiftHour: {
      type: "number",
      nullable: true,
      description: "Accepted individual units per shift hour; null when eligible duration is zero",
    },
  },
};

const aggregationMetricsOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "closedBoxes",
    "containedUnits",
    "shiftHours",
    "boxesPerShiftHour",
    "containedUnitsPerShiftHour",
  ],
  properties: {
    closedBoxes: { type: "integer", minimum: 0 },
    containedUnits: { type: "integer", minimum: 0 },
    shiftHours: { type: "number", minimum: 0, description: "Elapsed shift hours" },
    boxesPerShiftHour: {
      type: "number",
      nullable: true,
      description: "Closed non-disassembled boxes per shift hour; null when eligible duration is zero",
    },
    containedUnitsPerShiftHour: {
      type: "number",
      nullable: true,
      description: "Accepted units in closed boxes per shift hour; null when eligible duration is zero",
    },
  },
};

const windowProperties = {
  start: { type: "string", format: "date-time" },
  end: { type: "string", format: "date-time" },
  validation: validationMetricsOpenApiSchema,
  aggregation: aggregationMetricsOpenApiSchema,
};

const windowOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["start", "end", "validation", "aggregation"],
  properties: windowProperties,
};

const bucketOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["start", "end", "label", "validation", "aggregation"],
  properties: {
    ...windowProperties,
    label: { type: "string" },
  },
};

const reasonOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "severity", "count"],
  properties: {
    code: {
      type: "string",
      enum: ["unreviewed_conflicts", "late_data", "missing_shift_duration"],
    },
    severity: { type: "string", enum: ["needs_attention", "critical"] },
    count: { type: "integer", minimum: 1 },
    route: { type: "string" },
    affectedModes: { type: "array", items: { type: "string", enum: ["validation", "aggregation"] } },
  },
};

const qualityOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "reasons", "activeShiftCount", "lateDataShiftCount", "sources"],
  properties: {
    status: { type: "string", enum: ["complete", "provisional", "insufficient"] },
    reasons: {
      type: "array",
      items: { type: "string", enum: ["active_shifts", "late_data", "missing_shift_duration"] },
    },
    activeShiftCount: { type: "integer", minimum: 0 },
    lateDataShiftCount: { type: "integer", minimum: 0 },
    sources: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      uniqueItems: true,
      items: { type: "string", enum: ["code_registry", "boxes", "box_items"] },
    },
  },
};

const activeShiftOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "number", "productName", "lineName", "openedAt", "lateDataAt", "output"],
  properties: {
    id: { type: "string", format: "uuid" },
    number: { type: "string" },
    productName: { type: "string", nullable: true },
    lineName: { type: "string", nullable: true },
    openedAt: { type: "string", format: "date-time" },
    lateDataAt: { type: "string", format: "date-time", nullable: true },
    output: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["mode", "acceptedUnits"],
          properties: {
            mode: { type: "string", enum: ["validation"] },
            acceptedUnits: { type: "integer", minimum: 0 },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["mode", "closedBoxes", "containedUnits"],
          properties: {
            mode: { type: "string", enum: ["aggregation"] },
            closedBoxes: { type: "integer", minimum: 0 },
            containedUnits: { type: "integer", minimum: 0 },
          },
        },
      ],
    },
  },
};

export const dashboardOverviewOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "generatedAt",
    "timeZone",
    "metricVersion",
    "setup",
    "verdict",
    "today",
    "dynamics",
    "activeShifts",
  ],
  properties: {
    generatedAt: { type: "string", format: "date-time" },
    timeZone: { type: "string", description: "Stored tenant operational IANA timezone" },
    metricVersion: { type: "string", enum: ["operations-dashboard-v1"] },
    setup: {
      type: "object",
      additionalProperties: false,
      required: ["productCount", "shiftCount", "hasRunShift"],
      properties: {
        productCount: { type: "integer", minimum: 0 },
        shiftCount: { type: "integer", minimum: 0 },
        hasRunShift: { type: "boolean" },
      },
    },
    verdict: {
      type: "object",
      additionalProperties: false,
      required: ["status", "reasons"],
      properties: {
        status: { type: "string", enum: ["under_control", "needs_attention", "critical"] },
        reasons: { type: "array", items: reasonOpenApiSchema },
      },
    },
    today: {
      type: "object",
      additionalProperties: false,
      required: [
        "validationAcceptedUnits",
        "aggregationClosedBoxes",
        "aggregationContainedUnits",
        "activeShiftCount",
        "includedClosedShiftCount",
      ],
      properties: {
        validationAcceptedUnits: { type: "integer", minimum: 0 },
        aggregationClosedBoxes: { type: "integer", minimum: 0 },
        aggregationContainedUnits: { type: "integer", minimum: 0 },
        activeShiftCount: { type: "integer", minimum: 0 },
        includedClosedShiftCount: { type: "integer", minimum: 0 },
      },
    },
    dynamics: {
      type: "object",
      additionalProperties: false,
      required: ["period", "grain", "currentWindow", "comparisonWindow", "buckets", "quality"],
      properties: {
        period: { type: "string", enum: [...dashboardPeriods] },
        grain: { type: "string", enum: ["hour", "day", "week"] },
        currentWindow: windowOpenApiSchema,
        comparisonWindow: windowOpenApiSchema,
        buckets: { type: "array", items: bucketOpenApiSchema },
        quality: qualityOpenApiSchema,
      },
    },
    activeShifts: { type: "array", items: activeShiftOpenApiSchema },
  },
};
