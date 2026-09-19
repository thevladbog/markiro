import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
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
import { ChzKmOrdersService } from "./chz-km-orders.service";
import {
  chzKmOrderIdSchema,
  chzKmOrderListOpenApiSchema,
  chzKmOrderNotFailedOpenApiSchema,
  chzKmOrderOpenApiSchema,
  chzKmOrderPreflightFailedOpenApiSchema,
  createChzKmOrderOpenApiSchema,
  createChzKmOrderSchema,
  type ChzKmOrderDto,
  type ChzKmOrderListDto,
  type CreateChzKmOrderDto,
} from "./dto";

@ApiTags("chz-km-orders")
@ApiCabinetAuth()
@Controller("chz-km-orders")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class ChzKmOrdersController {
  constructor(private readonly chzKmOrders: ChzKmOrdersService) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "List Chestny ZNAK marking-code orders" })
  @ApiOkResponse({ schema: chzKmOrderListOpenApiSchema })
  @ApiHttpErrors(401, 403)
  list(@Req() req: RequestWithTenant): Promise<ChzKmOrderListDto> {
    return this.chzKmOrders.list(req.tenantId!);
  }

  @Get(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "Get a Chestny ZNAK marking-code order" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: chzKmOrderOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  get(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(chzKmOrderIdSchema)) id: string,
  ): Promise<ChzKmOrderDto> {
    return this.chzKmOrders.get(req.tenantId!, id);
  }

  @Post()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({
    summary: "Order Chestny ZNAK marking codes for a product",
    description:
      "Refuses the order (422) unless every pre-flight condition holds: СУЗ settings, a paired " +
      "signer agent, a usable СУЗ token, and a product with a GTIN and a supported product " +
      "group carrying exactly one UNIT template.",
  })
  @ApiBody({ schema: createChzKmOrderOpenApiSchema })
  @ApiCreatedResponse({ schema: chzKmOrderOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  @ApiResponse({
    status: 422,
    schema: chzKmOrderPreflightFailedOpenApiSchema,
    description:
      "One or more pre-flight conditions block the order; `blockedBy` lists all of them.",
  })
  create(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createChzKmOrderSchema)) body: CreateChzKmOrderDto,
  ): Promise<ChzKmOrderDto> {
    return this.chzKmOrders.create(req.tenantId!, req.userId!, body);
  }

  @Post(":id/retry")
  @HttpCode(200)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({
    summary: "Retry a failed Chestny ZNAK marking-code order",
    description:
      "Only accepted from the failed state: a rejected order is Chestny ZNAK's own verdict, " +
      "not a transient failure.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: chzKmOrderOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  @ApiResponse({
    status: 409,
    schema: chzKmOrderNotFailedOpenApiSchema,
    description: "The order is not in the failed state.",
  })
  retry(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(chzKmOrderIdSchema)) id: string,
  ): Promise<ChzKmOrderDto> {
    return this.chzKmOrders.retry(req.tenantId!, id);
  }
}
