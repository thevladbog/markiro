import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { SecurityAuditService } from "../../authorization/security-audit.service";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodQuery,
  ApiZodValidationError,
} from "../../lib/openapi";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  boxSellCodesOpenApiSchema,
  listBoxesOpenApiSchema,
  listBoxesQuerySchema,
  sellCodesQuerySchema,
  type BoxSellCodesDto,
  type ListBoxesQueryDto,
  type ListBoxesResponseDto,
  type SellCodesQueryDto,
} from "./dto";
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
@ApiCabinetAuth()
export class BoxesController {
  constructor(
    private readonly boxesService: BoxesService,
    private readonly audit: SecurityAuditService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "List boxes for a shift",
    description: "Ordered by closedAt descending with still-open boxes first.",
  })
  @ApiZodQuery(listBoxesQuerySchema)
  @ApiOkResponse({ schema: listBoxesOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  async listBoxes(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listBoxesQuerySchema)) query: ListBoxesQueryDto,
  ): Promise<ListBoxesResponseDto> {
    return this.boxesService.listBoxes(req.tenantId!, query);
  }

  /**
   * Sell-at-register: the ONLY cabinet read that returns raw KM payloads,
   * so each successful call is audit-logged (who viewed which box's codes).
   */
  @Get("sell-codes")
  @ApiOperation({
    summary: "Get a closed box's sellable codes",
    description:
      "Sell-at-register: the only cabinet read that returns raw KM payloads, so each successful call is audit-logged. The scanned SSCC is normalized (AIM prefix, printed (00), bare 00 AI). Rejected (409) when the box is not closed, disassembled, or empty.",
  })
  @ApiZodQuery(sellCodesQuerySchema)
  @ApiOkResponse({ schema: boxSellCodesOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409)
  async getSellCodes(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(sellCodesQuerySchema)) query: SellCodesQueryDto,
  ): Promise<BoxSellCodesDto> {
    const result = await this.boxesService.getSellCodes(req.tenantId!, query.sscc);
    this.audit.sensitiveRead({
      tenantId: req.tenantId!,
      userId: req.userId ?? null,
      action: "boxes.sell_codes.read",
      resourceId: result.boxId,
    });
    return result;
  }
}
