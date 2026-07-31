import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { SessionOnlyGuard } from "../../tenancy/session-only.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  listBoxExceptionsQuerySchema,
  type ListBoxExceptionsQueryDto,
  type ListBoxExceptionsResponseDto,
} from "./dto";
import { BoxExceptionsService } from "./box-exceptions.service";

/**
 * Manager-only, same reasoning as boxes.controller.ts: a station has no
 * business browsing the exception ledger, its own or another terminal's --
 * this is the audit trail a manager reviews, not a floor concern.
 * `SessionOnlyGuard` keeps a station api-key out even though `TenantGuard`
 * accepts it for tenant resolution -- see docs/device-key-surface.md.
 */
@ApiTags("box-exceptions")
@Controller("box-exceptions")
@UseGuards(TenantGuard, SessionOnlyGuard)
export class BoxExceptionsController {
  constructor(private readonly boxExceptionsService: BoxExceptionsService) {}

  @Get()
  async listBoxExceptions(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listBoxExceptionsQuerySchema)) query: ListBoxExceptionsQueryDto,
  ): Promise<ListBoxExceptionsResponseDto> {
    return this.boxExceptionsService.listBoxExceptions(req.tenantId!, query);
  }
}
