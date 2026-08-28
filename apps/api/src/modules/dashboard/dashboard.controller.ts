import { Controller, Get, Inject, Query, Req, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";

import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { AllowSubscriptionReadOnly } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  dashboardOverviewOpenApiSchema,
  dashboardOverviewQuerySchema,
  dashboardPeriods,
  type DashboardOverviewDto,
  type DashboardOverviewQueryDto,
} from "./dto";
import { DashboardService } from "./dashboard.service";

type DashboardRequest = Pick<RequestWithTenant, "tenantId"> & { tenantId: string };

@ApiTags("dashboard")
@Controller("dashboard")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
export class DashboardController {
  constructor(
    @Inject(DashboardService) private readonly dashboard: Pick<DashboardService, "overview">,
  ) {}

  @Get("overview")
  @ApiOperation({ summary: "Read the tenant production dashboard overview" })
  @ApiQuery({
    name: "period",
    required: false,
    schema: { type: "string", enum: [...dashboardPeriods], default: "7d" },
  })
  @ApiOkResponse({ schema: dashboardOverviewOpenApiSchema })
  overview(
    @Req() req: DashboardRequest,
    @Query(new ZodValidationPipe(dashboardOverviewQuerySchema)) query: DashboardOverviewQueryDto,
  ): Promise<DashboardOverviewDto> {
    return this.dashboard.overview(req.tenantId, query.period);
  }
}
