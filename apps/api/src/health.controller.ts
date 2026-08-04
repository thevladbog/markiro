import { Controller, Get, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { ReadinessService } from "./health/readiness.service";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get()
  health() {
    return this.readiness.live();
  }

  @Get("live")
  live() {
    return this.readiness.live();
  }

  @Get("ready")
  async ready(@Res({ passthrough: true }) response: Response) {
    const report = await this.readiness.ready();
    if (report.status === "unavailable") response.status(503);
    return report;
  }
}
