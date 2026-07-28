import { Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { SessionOnlyGuard } from "../../tenancy/session-only.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
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
 * human ever sees that class of conflict. `SessionOnlyGuard` keeps a station
 * api-key out even though `TenantGuard` accepts it for tenant resolution --
 * see docs/device-key-surface.md and operators.controller.ts for the same
 * pattern.
 */
@ApiTags("conflicts")
@Controller("conflicts")
@UseGuards(TenantGuard, SessionOnlyGuard)
export class ConflictsController {
  constructor(private readonly conflictsService: ConflictsService) {}

  @Get()
  async listConflicts(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listConflictsQuerySchema)) query: ListConflictsQueryDto,
  ): Promise<ListConflictsResponseDto> {
    return this.conflictsService.listConflicts(req.tenantId!, query);
  }

  @Post(":id/review")
  @HttpCode(200)
  async reviewConflict(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<ConflictDto> {
    return this.conflictsService.reviewConflict(req.tenantId!, id);
  }
}
