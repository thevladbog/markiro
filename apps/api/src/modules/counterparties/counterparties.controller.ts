import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  createCounterpartySchema,
  updateCounterpartySchema,
  type CounterpartyDto,
  type CreateCounterpartyDto,
  type ListCounterpartiesResponseDto,
  type UpdateCounterpartyDto,
} from "./dto";
import { CounterpartiesService } from "./counterparties.service";

@Controller("counterparties")
@UseGuards(TenantGuard)
export class CounterpartiesController {
  constructor(private readonly counterpartiesService: CounterpartiesService) {}

  @Get()
  async listCounterparties(@Req() req: RequestWithTenant): Promise<ListCounterpartiesResponseDto> {
    return this.counterpartiesService.listCounterparties(req.tenantId!);
  }

  @Get(":id")
  async getCounterparty(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<CounterpartyDto> {
    try {
      return await this.counterpartiesService.getCounterparty(req.tenantId!, id);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw error;
    }
  }

  @Post()
  async createCounterparty(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createCounterpartySchema)) body: CreateCounterpartyDto,
  ): Promise<CounterpartyDto> {
    return this.counterpartiesService.createCounterparty(req.tenantId!, body);
  }

  @Patch(":id")
  async updateCounterparty(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateCounterpartySchema)) body: UpdateCounterpartyDto,
  ): Promise<CounterpartyDto> {
    return this.counterpartiesService.updateCounterparty(req.tenantId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  async deleteCounterparty(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.counterpartiesService.deleteCounterparty(req.tenantId!, id);
  }
}
