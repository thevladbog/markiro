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
import { ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { RequireSubscriptionWrite } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  createCounterpartySchema,
  ssccCounterSchema,
  updateCounterpartySchema,
  type CounterpartyDto,
  type CreateCounterpartyDto,
  type ListCounterpartiesResponseDto,
  type SsccCounterDto,
  type UpdateCounterpartyDto,
} from "./dto";
import { CounterpartiesService } from "./counterparties.service";

@ApiTags("counterparties")
@Controller("counterparties")
// The station never calls this module. Cabinet authorization keeps a station
// api-key out even though TenantGuard accepts it for tenant resolution.
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
export class CounterpartiesController {
  constructor(private readonly counterpartiesService: CounterpartiesService) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async listCounterparties(@Req() req: RequestWithTenant): Promise<ListCounterpartiesResponseDto> {
    return this.counterpartiesService.listCounterparties(req.tenantId!);
  }

  @Get(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async getCounterparty(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<CounterpartyDto> {
    return this.counterpartiesService.getCounterparty(req.tenantId!, id);
  }

  @Post()
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async createCounterparty(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createCounterpartySchema)) body: CreateCounterpartyDto,
  ): Promise<CounterpartyDto> {
    return this.counterpartiesService.createCounterparty(req.tenantId!, body);
  }

  @Patch(":id")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
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
  async deleteCounterparty(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.counterpartiesService.deleteCounterparty(req.tenantId!, id);
  }

  @Get(":id/sscc")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async getSscc(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<SsccCounterDto> {
    return this.counterpartiesService.getSscc(req.tenantId!, id);
  }

  @Put(":id/sscc")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async putSscc(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ssccCounterSchema)) body: SsccCounterDto,
  ): Promise<SsccCounterDto> {
    return this.counterpartiesService.putSscc(req.tenantId!, id, body);
  }
}
