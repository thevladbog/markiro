import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { ApiCabinetAuth, ApiHttpErrors, ApiZodValidationError } from "../../lib/openapi";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { inventoryIdSchema } from "../inventories/dto";
import { ChzExportsService } from "./chz-exports.service";
import {
  chzExportStateOpenApiSchema,
  retryChzExportOpenApiSchema,
  retryChzExportSchema,
  type ChzExportStateDto,
  type RetryChzExportDto,
} from "./dto";

@ApiTags("inventories")
@ApiCabinetAuth()
@Controller("inventories")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class ChzExportsController {
  constructor(private readonly chzExports: ChzExportsService) {}

  @Get(":id/chz-exports")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "Get an inventory's Chestny ZNAK export state" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: chzExportStateOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  getState(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
  ): Promise<ChzExportStateDto> {
    return this.chzExports.getState(req.tenantId!, id);
  }

  @Post(":id/chz-exports")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({
    summary: "Order Chestny ZNAK code-status exports for an inventory",
    description:
      "Orders one dispenser export per Chestny ZNAK status. Ordering consumes the tenant's daily task quota, so statuses that are already in flight or imported are left alone.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiCreatedResponse({ schema: chzExportStateOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  order(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
  ): Promise<ChzExportStateDto> {
    return this.chzExports.order(req.tenantId!, req.userId!, id);
  }

  @Post(":id/chz-exports/retry")
  @HttpCode(200)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({ summary: "Retry a failed Chestny ZNAK export run" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({ schema: retryChzExportOpenApiSchema })
  @ApiOkResponse({ schema: chzExportStateOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 409)
  retry(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Body(new ZodValidationPipe(retryChzExportSchema)) body: RetryChzExportDto,
  ): Promise<ChzExportStateDto> {
    return this.chzExports.retry(req.tenantId!, req.userId!, id, body.status);
  }
}
