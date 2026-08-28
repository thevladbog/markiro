import { Inject, Injectable } from "@nestjs/common";

import type {
  DashboardDataQualityDto,
  DashboardGrain,
  DashboardOverviewDto,
  DashboardPeriod,
  DashboardQualityReasonCode,
  DashboardReasonDto,
} from "./dto";
import type { DashboardOverviewFacts, DashboardRepository } from "./dashboard.repository";

export const DASHBOARD_REPOSITORY = Symbol("DASHBOARD_REPOSITORY");

const reasonRoutes = {
  unreviewed_conflicts: "/conflicts",
  late_data: "/shifts",
  missing_shift_duration: "/shifts",
} as const;

const grainByPeriod = {
  today: "hour",
  "7d": "day",
  "30d": "day",
  "12w": "week",
} as const satisfies Record<DashboardPeriod, DashboardGrain>;

const severityOrder = {
  critical: 0,
  needs_attention: 1,
} as const;

@Injectable()
export class DashboardService {
  constructor(
    @Inject(DASHBOARD_REPOSITORY) private readonly repository: DashboardRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async overview(tenantId: string, period: DashboardPeriod): Promise<DashboardOverviewDto> {
    const facts = await this.repository.load(tenantId, period, this.now());
    const reasons = this.verdictReasons(facts);
    const quality = this.quality(facts);

    return {
      generatedAt: facts.generatedAt.toISOString(),
      timeZone: facts.timeZone,
      metricVersion: "operations-dashboard-v1",
      setup: {
        productCount: facts.setup.productCount,
        shiftCount: facts.setup.shiftCount,
        hasRunShift: facts.setup.hasRunShift,
      },
      verdict: {
        status:
          facts.unreviewedConflictCount > 0
            ? "critical"
            : reasons.length > 0
              ? "needs_attention"
              : "under_control",
        reasons,
      },
      today: facts.today,
      dynamics: {
        period,
        grain: grainByPeriod[period],
        currentWindow: facts.currentWindow,
        comparisonWindow: facts.comparisonWindow,
        buckets: facts.buckets,
        quality,
      },
      activeShifts: facts.activeShifts,
    };
  }

  private verdictReasons(
    facts: Pick<
      DashboardOverviewFacts,
      "unreviewedConflictCount" | "todayLateDataShiftCount" | "missingDurationModes"
    >,
  ): DashboardReasonDto[] {
    const reasons: DashboardReasonDto[] = [];

    if (facts.unreviewedConflictCount > 0) {
      reasons.push({
        code: "unreviewed_conflicts",
        severity: "critical",
        count: facts.unreviewedConflictCount,
        route: reasonRoutes.unreviewed_conflicts,
      });
    }
    if (facts.todayLateDataShiftCount > 0) {
      reasons.push({
        code: "late_data",
        severity: "needs_attention",
        count: facts.todayLateDataShiftCount,
        route: reasonRoutes.late_data,
      });
    }
    if (facts.missingDurationModes.length > 0) {
      reasons.push({
        code: "missing_shift_duration",
        severity: "needs_attention",
        count: facts.missingDurationModes.length,
        route: reasonRoutes.missing_shift_duration,
        affectedModes: facts.missingDurationModes,
      });
    }

    return reasons.sort((left, right) => {
      return (
        severityOrder[left.severity] - severityOrder[right.severity] ||
        left.code.localeCompare(right.code)
      );
    });
  }

  private quality(
    facts: Pick<
      DashboardOverviewFacts,
      "setup" | "selectedWindowLateDataShiftCount" | "missingDurationModes"
    >,
  ): DashboardDataQualityDto {
    const reasons: DashboardQualityReasonCode[] = [];
    if (facts.setup.activeShiftCount > 0) reasons.push("active_shifts");
    if (facts.selectedWindowLateDataShiftCount > 0) reasons.push("late_data");
    if (facts.missingDurationModes.length > 0) reasons.push("missing_shift_duration");

    return {
      status:
        facts.missingDurationModes.length > 0
          ? "insufficient"
          : facts.setup.activeShiftCount > 0 || facts.selectedWindowLateDataShiftCount > 0
            ? "provisional"
            : "complete",
      reasons,
      activeShiftCount: facts.setup.activeShiftCount,
      lateDataShiftCount: facts.selectedWindowLateDataShiftCount,
      sources: ["code_registry", "boxes", "box_items"],
    };
  }
}
