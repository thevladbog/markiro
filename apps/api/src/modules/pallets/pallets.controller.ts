import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodQuery,
  ApiZodValidationError,
} from "../../lib/openapi";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  listPalletsOpenApiSchema,
  listPalletsQuerySchema,
  type ListPalletsQueryDto,
  type ListPalletsResponseDto,
} from "./dto";
import { PalletsService } from "./pallets.service";

/**
 * Manager-only, mirroring `BoxesController` exactly: `contentsChangedAfterClose`
 * (see dto.ts) exists so a manager can tell a closed, labelled pallet left a
 * box short it can no longer physically correct -- there is no station-facing
 * need to browse another terminal's pallets at all. Cabinet authorization
 * keeps a station api-key out even though `TenantGuard` accepts it for tenant
 * resolution -- see docs/device-key-surface.md and boxes.controller.ts for
 * the same pattern.
 */
@ApiTags("pallets")
@Controller("pallets")
@UseGuards(TenantGuard, AuthorizationGuard)
@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
@ApiCabinetAuth()
export class PalletsController {
  constructor(private readonly palletsService: PalletsService) {}

  @Get()
  @ApiOperation({
    summary: "List pallets for a shift",
    description: "Ordered by closedAt descending with still-open pallets first.",
  })
  @ApiZodQuery(listPalletsQuerySchema)
  @ApiOkResponse({ schema: listPalletsOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  async listPallets(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listPalletsQuerySchema)) query: ListPalletsQueryDto,
  ): Promise<ListPalletsResponseDto> {
    return this.palletsService.listPallets(req.tenantId!, query);
  }
}
