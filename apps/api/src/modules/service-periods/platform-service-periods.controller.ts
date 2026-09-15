import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  platformServicePeriodContracts,
  type ServiceExcessApprovalPostInput,
  type ServiceExcessApprovalWithdrawalInput,
  type ServiceUsageCorrectionInput,
  type ServiceUsagePostInput,
} from "@markiro/platform-contracts";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { PlatformApiProtectedOk } from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import type { ServicePeriodListQuery } from "./dto";
import { ServicePeriodsService } from "./service-periods.service";

@ApiTags("platform-service-periods")
@Controller("platform/service-periods")
export class PlatformServicePeriodsController {
  constructor(private readonly periods: ServicePeriodsService) {}

  @Get()
  @ApiOperation({ summary: "List recurring service periods" })
  @PlatformApiProtectedOk({
    query: platformServicePeriodContracts.list.query,
    response: platformServicePeriodContracts.list.response,
  })
  @RequirePlatformCapabilities("services.read")
  async list(
    @Req() request: RequestWithPlatformPrincipal,
    @Query(new ZodValidationPipe(platformServicePeriodContracts.list.query))
    query: ServicePeriodListQuery,
  ) {
    return parsePlatformResponse(
      platformServicePeriodContracts.list.response,
      await this.periods.list(request.platformPrincipal!, query),
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "Read a recurring service period ledger" })
  @PlatformApiProtectedOk({ response: platformServicePeriodContracts.detail.response })
  @RequirePlatformCapabilities("services.read")
  async detail(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(platformServicePeriodContracts.detail.params.shape.id))
    id: string,
  ) {
    return parsePlatformResponse(
      platformServicePeriodContracts.detail.response,
      await this.periods.detail(request.platformPrincipal!, id),
    );
  }

  @Post(":id/usage")
  @HttpCode(200)
  @ApiOperation({ summary: "Post work against a recurring service period" })
  @PlatformApiProtectedOk({
    body: platformServicePeriodContracts.postUsage.body,
    response: platformServicePeriodContracts.postUsage.response,
  })
  @RequirePlatformCapabilities("services.write")
  async postUsage(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(platformServicePeriodContracts.postUsage.params.shape.id))
    id: string,
    @Body(new ZodValidationPipe(platformServicePeriodContracts.postUsage.body))
    body: ServiceUsagePostInput,
  ) {
    return parsePlatformResponse(
      platformServicePeriodContracts.postUsage.response,
      await this.periods.postUsage(request.platformPrincipal!, id, body),
    );
  }

  @Post(":id/usage/:entryId/corrections")
  @HttpCode(200)
  @ApiOperation({ summary: "Correct a recurring service usage entry" })
  @PlatformApiProtectedOk({
    body: platformServicePeriodContracts.correctUsage.body,
    response: platformServicePeriodContracts.correctUsage.response,
  })
  @RequirePlatformCapabilities("services.write")
  async correctUsage(
    @Req() request: RequestWithPlatformPrincipal,
    @Param(new ZodValidationPipe(platformServicePeriodContracts.correctUsage.params))
    params: { id: string; entryId: string },
    @Body(new ZodValidationPipe(platformServicePeriodContracts.correctUsage.body))
    body: ServiceUsageCorrectionInput,
  ) {
    return parsePlatformResponse(
      platformServicePeriodContracts.correctUsage.response,
      await this.periods.correctUsage(request.platformPrincipal!, params.id, params.entryId, body),
    );
  }

  @Post(":id/approvals")
  @HttpCode(200)
  @ApiOperation({ summary: "Register externally approved excess service capacity" })
  @PlatformApiProtectedOk({
    body: platformServicePeriodContracts.addApproval.body,
    response: platformServicePeriodContracts.addApproval.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async addApproval(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(platformServicePeriodContracts.addApproval.params.shape.id))
    id: string,
    @Body(new ZodValidationPipe(platformServicePeriodContracts.addApproval.body))
    body: ServiceExcessApprovalPostInput,
  ) {
    return parsePlatformResponse(
      platformServicePeriodContracts.addApproval.response,
      await this.periods.addApproval(request.platformPrincipal!, id, body),
    );
  }

  @Post(":id/approvals/:approvalId/withdrawals")
  @HttpCode(200)
  @ApiOperation({ summary: "Withdraw externally approved service capacity" })
  @PlatformApiProtectedOk({
    body: platformServicePeriodContracts.withdrawApproval.body,
    response: platformServicePeriodContracts.withdrawApproval.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async withdrawApproval(
    @Req() request: RequestWithPlatformPrincipal,
    @Param(new ZodValidationPipe(platformServicePeriodContracts.withdrawApproval.params))
    params: { id: string; approvalId: string },
    @Body(new ZodValidationPipe(platformServicePeriodContracts.withdrawApproval.body))
    body: ServiceExcessApprovalWithdrawalInput,
  ) {
    return parsePlatformResponse(
      platformServicePeriodContracts.withdrawApproval.response,
      await this.periods.withdrawApproval(
        request.platformPrincipal!,
        params.id,
        params.approvalId,
        body,
      ),
    );
  }
}
