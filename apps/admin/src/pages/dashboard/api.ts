import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";

import { apiFetch } from "../../api/client.js";

const dashboardPeriodSchema = z.enum(["today", "7d", "30d", "12w"]);
const dashboardModeSchema = z.enum(["validation", "aggregation"]);
const dashboardDataSourceSchema = z.enum(["code_registry", "boxes", "box_items"]);
const dashboardDataSourcesSchema = z
  .tuple([dashboardDataSourceSchema, dashboardDataSourceSchema, dashboardDataSourceSchema])
  .refine((sources) => new Set(sources).size === 3, {
    message: "Dashboard data sources must contain each source exactly once",
  });
const dashboardValidationMetricsSchema = z
  .object({
    acceptedUnits: z.number().int().nonnegative(),
    shiftHours: z.number().nonnegative(),
    unitsPerShiftHour: z.number().nonnegative().nullable(),
  })
  .strict();
const dashboardAggregationMetricsSchema = z
  .object({
    closedBoxes: z.number().int().nonnegative(),
    containedUnits: z.number().int().nonnegative(),
    shiftHours: z.number().nonnegative(),
    boxesPerShiftHour: z.number().nonnegative().nullable(),
    containedUnitsPerShiftHour: z.number().nonnegative().nullable(),
  })
  .strict();
const dashboardWindowSchema = z
  .object({
    start: z.string().datetime(),
    end: z.string().datetime(),
    validation: dashboardValidationMetricsSchema,
    aggregation: dashboardAggregationMetricsSchema,
  })
  .strict();
const dashboardBucketSchema = dashboardWindowSchema.extend({ label: z.string() }).strict();
const dashboardReasonSchema = z
  .object({
    code: z.enum(["unreviewed_conflicts", "late_data", "missing_shift_duration"]),
    severity: z.enum(["needs_attention", "critical"]),
    count: z.number().int().positive(),
    route: z.string().optional(),
    affectedModes: z.array(dashboardModeSchema).optional(),
  })
  .strict();
const dashboardActiveShiftSchema = z
  .object({
    id: z.string().uuid(),
    number: z.string(),
    productName: z.string().nullable(),
    lineName: z.string().nullable(),
    openedAt: z.string().datetime(),
    lateDataAt: z.string().datetime().nullable(),
    output: z.discriminatedUnion("mode", [
      z
        .object({ mode: z.literal("validation"), acceptedUnits: z.number().int().nonnegative() })
        .strict(),
      z
        .object({
          mode: z.literal("aggregation"),
          closedBoxes: z.number().int().nonnegative(),
          containedUnits: z.number().int().nonnegative(),
        })
        .strict(),
    ]),
  })
  .strict();
const dashboardOverviewSchema = z
  .object({
    generatedAt: z.string().datetime(),
    timeZone: z.string(),
    metricVersion: z.literal("operations-dashboard-v1"),
    setup: z
      .object({
        productCount: z.number().int().nonnegative(),
        shiftCount: z.number().int().nonnegative(),
        hasRunShift: z.boolean(),
      })
      .strict(),
    verdict: z
      .object({
        status: z.enum(["under_control", "needs_attention", "critical"]),
        reasons: z.array(dashboardReasonSchema),
      })
      .strict(),
    today: z
      .object({
        validationAcceptedUnits: z.number().int().nonnegative(),
        aggregationClosedBoxes: z.number().int().nonnegative(),
        aggregationContainedUnits: z.number().int().nonnegative(),
        activeShiftCount: z.number().int().nonnegative(),
        includedClosedShiftCount: z.number().int().nonnegative(),
      })
      .strict(),
    dynamics: z
      .object({
        period: dashboardPeriodSchema,
        grain: z.enum(["hour", "day", "week"]),
        currentWindow: dashboardWindowSchema,
        comparisonWindow: dashboardWindowSchema,
        buckets: z.array(dashboardBucketSchema),
        quality: z
          .object({
            status: z.enum(["complete", "provisional", "insufficient"]),
            reasons: z.array(z.enum(["active_shifts", "late_data", "missing_shift_duration"])),
            activeShiftCount: z.number().int().nonnegative(),
            lateDataShiftCount: z.number().int().nonnegative(),
            sources: dashboardDataSourcesSchema,
          })
          .strict(),
      })
      .strict(),
    activeShifts: z.array(dashboardActiveShiftSchema),
  })
  .strict();

export type DashboardPeriod = z.infer<typeof dashboardPeriodSchema>;
export type DashboardOverviewDto = z.infer<typeof dashboardOverviewSchema>;

export const DASHBOARD_QUERY_KEY = ["dashboard", "overview"] as const;

async function fetchDashboardOverview(period: DashboardPeriod): Promise<DashboardOverviewDto> {
  const response = await apiFetch<unknown>(
    `/dashboard/overview?period=${encodeURIComponent(period)}`,
  );
  return dashboardOverviewSchema.parse(response);
}

export function useDashboardOverview(
  period: DashboardPeriod,
): UseQueryResult<DashboardOverviewDto> {
  return useQuery({
    queryKey: [...DASHBOARD_QUERY_KEY, period],
    queryFn: () => fetchDashboardOverview(period),
  });
}
