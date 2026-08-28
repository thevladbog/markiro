import { Controller, Get, Res } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { liveReportOpenApiSchema, readinessReportOpenApiSchema } from "./health/health.openapi";
import { ReadinessService } from "./health/readiness.service";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get()
  @ApiOperation({ summary: "Liveness probe" })
  @ApiOkResponse({ schema: liveReportOpenApiSchema })
  health() {
    return this.readiness.live();
  }

  @Get("live")
  @ApiOperation({ summary: "Liveness probe (alias)" })
  @ApiOkResponse({ schema: liveReportOpenApiSchema })
  live() {
    return this.readiness.live();
  }

  @Get("ready")
  @ApiOperation({
    summary: "Readiness probe",
    description:
      "Probes database, jobs, smtp, and storage, with results cached for a short window. An " +
      "unavailable database or jobs queue makes the whole report `unavailable` (and the " +
      "response a 503); a failing smtp or storage probe only degrades it.",
  })
  @ApiOkResponse({
    schema: readinessReportOpenApiSchema,
    description: "Every hard dependency responded; the report is `ok` or `degraded`.",
  })
  @ApiResponse({
    status: 503,
    schema: readinessReportOpenApiSchema,
    description: 'Database or jobs are unavailable; same report body with `status: "unavailable"`.',
  })
  async ready(@Res({ passthrough: true }) response: Response) {
    const report = await this.readiness.ready();
    if (report.status === "unavailable") response.status(503);
    return report;
  }
}
