import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
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
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodBody,
  ApiZodResponse,
  ApiZodValidationError,
} from "../../lib/openapi";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  counterpartyOpenApiSchema,
  createCounterpartySchema,
  listCounterpartiesOpenApiSchema,
  ssccCounterSchema,
  ssccCounterStateOpenApiSchema,
  updateCounterpartySchema,
  type CounterpartyDto,
  type CreateCounterpartyDto,
  type ListCounterpartiesResponseDto,
  type SsccCounterDto,
  type UpdateCounterpartyDto,
} from "./dto";
import type { SsccCounterStateDto } from "../sscc/dto";
import { CounterpartiesService } from "./counterparties.service";

@ApiTags("counterparties")
@Controller("counterparties")
// The station never calls this module. Cabinet authorization keeps a station
// api-key out even though TenantGuard accepts it for tenant resolution.
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@ApiCabinetAuth()
export class CounterpartiesController {
  constructor(private readonly counterpartiesService: CounterpartiesService) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "List counterparties" })
  @ApiOkResponse({ schema: listCounterpartiesOpenApiSchema })
  @ApiHttpErrors(401, 403)
  async listCounterparties(@Req() req: RequestWithTenant): Promise<ListCounterpartiesResponseDto> {
    return this.counterpartiesService.listCounterparties(req.tenantId!);
  }

  @Get(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "Get a counterparty" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: counterpartyOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  async getCounterparty(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<CounterpartyDto> {
    return this.counterpartiesService.getCounterparty(req.tenantId!, id);
  }

  @Post()
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Create a counterparty" })
  @ApiZodBody(createCounterpartySchema)
  @ApiCreatedResponse({ schema: counterpartyOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  async createCounterparty(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createCounterpartySchema)) body: CreateCounterpartyDto,
  ): Promise<CounterpartyDto> {
    return this.counterpartiesService.createCounterparty(req.tenantId!, body);
  }

  @Patch(":id")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({
    summary: "Update a counterparty",
    description: "Partial update: untouched fields are preserved.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(updateCounterpartySchema)
  @ApiOkResponse({ schema: counterpartyOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  async updateCounterparty(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateCounterpartySchema)) body: UpdateCounterpartyDto,
  ): Promise<CounterpartyDto> {
    return this.counterpartiesService.updateCounterparty(req.tenantId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Delete a counterparty" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiResponse({ status: 204, description: "Counterparty deleted." })
  @ApiHttpErrors(401, 403, 404, 409)
  async deleteCounterparty(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.counterpartiesService.deleteCounterparty(req.tenantId!, id);
  }

  @Get(":id/sscc")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Get a counterparty's SSCC counter state",
    description:
      "The box SSCC counter keyed by the counterparty's own GLN-derived prefix, plus the seed floor and any current reseed blocker.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: ssccCounterStateOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  async getSscc(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<SsccCounterStateDto> {
    return this.counterpartiesService.getSscc(req.tenantId!, id);
  }

  @Put(":id/sscc")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({
    summary: "Seed a counterparty's SSCC counter",
    description:
      "Reseeding revokes the serial blocks devices still hold, so it is rejected (409) while a shift is open or a device holding a block is out of sync, and rejected (400) below the printed-serial floor.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(ssccCounterSchema)
  @ApiZodResponse({ status: 200, schema: ssccCounterSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409)
  async putSscc(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ssccCounterSchema)) body: SsccCounterDto,
  ): Promise<SsccCounterDto> {
    return this.counterpartiesService.putSscc(req.tenantId!, id, body);
  }
}
