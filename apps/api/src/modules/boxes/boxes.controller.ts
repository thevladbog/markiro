import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { listBoxesQuerySchema, type ListBoxesQueryDto, type ListBoxesResponseDto } from "./dto";
import { BoxesService } from "./boxes.service";

/**
 * Manager-only: `contentsChangedAfterClose` (see dto.ts) exists so a manager
 * can tell a closed, taped-and-labelled box is short a scan it can no longer
 * physically correct -- there is no station-facing need to browse another
 * terminal's boxes at all. Cabinet authorization keeps a station api-key out
 * even though `TenantGuard` accepts it for tenant resolution -- see
 * docs/device-key-surface.md and conflicts.controller.ts for the same
 * pattern.
 */
@ApiTags("boxes")
@Controller("boxes")
@UseGuards(TenantGuard, AuthorizationGuard)
@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
export class BoxesController {
  constructor(private readonly boxesService: BoxesService) {}

  @Get()
  async listBoxes(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listBoxesQuerySchema)) query: ListBoxesQueryDto,
  ): Promise<ListBoxesResponseDto> {
    return this.boxesService.listBoxes(req.tenantId!, query);
  }
}
