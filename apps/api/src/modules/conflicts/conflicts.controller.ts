import { Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodQuery,
  ApiZodValidationError,
} from "../../lib/openapi";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  conflictOpenApiSchema,
  listConflictsOpenApiSchema,
  listConflictsQuerySchema,
  type ConflictDto,
  type ListConflictsQueryDto,
  type ListConflictsResponseDto,
} from "./dto";
import { ConflictsService } from "./conflicts.service";

/**
 * Manager-only: the losing side of a conflict is deliberately never told its
 * own scan lost (its batch was already acknowledged, and re-opening it would
 * undo slice 06a's delivery guarantee) -- this view is the only place a
 * human ever sees that class of conflict. Cabinet authorization keeps a station
 * api-key out even though `TenantGuard` accepts it for tenant resolution --
 * see docs/device-key-surface.md and operators.controller.ts for the same
 * pattern.
 */
@ApiTags("conflicts")
@ApiCabinetAuth()
@Controller("conflicts")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class ConflictsController {
  constructor(private readonly conflictsService: ConflictsService) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "List code conflicts",
    description:
      "The tenant's displaced-scan conflicts, newest detection first. shiftId filters by the LOSING shift only (the side never notified at scan time).",
  })
  @ApiZodQuery(listConflictsQuerySchema)
  @ApiOkResponse({ schema: listConflictsOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  async listConflicts(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listConflictsQuerySchema)) query: ListConflictsQueryDto,
  ): Promise<ListConflictsResponseDto> {
    return this.conflictsService.listConflicts(req.tenantId!, query);
  }

  @Post(":id/review")
  @HttpCode(200)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Mark a conflict as reviewed" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: conflictOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  async reviewConflict(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<ConflictDto> {
    return this.conflictsService.reviewConflict(req.tenantId!, id);
  }
}
