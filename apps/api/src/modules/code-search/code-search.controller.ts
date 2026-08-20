import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { AllowSubscriptionReadOnly } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  classifyQuerySchema,
  listCodesQuerySchema,
  type ClassifyQueryDto,
  type ClassifySearchResponseDto,
  type ListCodesQueryDto,
  type ListCodesResponseDto,
} from "./dto";
import { CodeSearchService } from "./code-search.service";

/**
 * Manager-only, entirely read-only module: classify a scanned/typed input
 * (SSCC or KM) to a box or a code, and browse the tenant's code registry
 * with derived status. Cabinet authorization keeps a station api-key out
 * even though `TenantGuard` accepts it for tenant resolution -- see
 * docs/device-key-surface.md and conflicts.controller.ts for the same
 * pattern.
 */
@ApiTags("code-search")
@Controller("code-search")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class CodeSearchController {
  constructor(private readonly codeSearchService: CodeSearchService) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async classify(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(classifyQuerySchema)) query: ClassifyQueryDto,
  ): Promise<ClassifySearchResponseDto> {
    return this.codeSearchService.classify(req.tenantId!, query.q);
  }

  @Get("codes")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async listCodes(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listCodesQuerySchema)) query: ListCodesQueryDto,
  ): Promise<ListCodesResponseDto> {
    return this.codeSearchService.listCodes(req.tenantId!, query);
  }
}
