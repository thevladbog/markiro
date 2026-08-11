import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  assignAddonSchema,
  assignPlanSchema,
  provisionTenantSchema,
  tenantListQuerySchema,
  tenantReferenceSchema,
  type AssignAddonDto,
  type AssignPlanDto,
  type ProvisionTenantDto,
  type TenantListQueryDto,
} from "./dto";
import { PlatformTenantsService } from "./platform-tenants.service";

@Controller("platform/tenants")
export class PlatformTenantsController {
  constructor(private readonly tenants: PlatformTenantsService) {}

  @Get()
  @RequirePlatformCapabilities("tenants.read")
  list(
    @Req() request: RequestWithPlatformPrincipal,
    @Query(new ZodValidationPipe(tenantListQuerySchema)) query: TenantListQueryDto,
  ) {
    return this.tenants.list(request.platformPrincipal!, query);
  }

  @Post()
  @RequirePlatformCapabilities("tenants.write")
  create(
    @Req() request: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(provisionTenantSchema)) body: ProvisionTenantDto,
  ) {
    return this.tenants.create(request.platformPrincipal!, body);
  }

  @Get(":id")
  @RequirePlatformCapabilities("tenants.read")
  get(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(tenantReferenceSchema)) id: string,
  ) {
    return this.tenants.get(request.platformPrincipal!, id);
  }

  @Post(":id/owner-activation/renew")
  @HttpCode(200)
  @RequirePlatformCapabilities("tenants.write")
  renewActivation(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(tenantReferenceSchema)) id: string,
  ) {
    return this.tenants.renewActivation(request.platformPrincipal!, id);
  }

  @Post(":id/subscription/plan")
  @RequirePlatformCapabilities("tenants.write", "billing.write")
  assignPlan(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(tenantReferenceSchema)) id: string,
    @Body(new ZodValidationPipe(assignPlanSchema)) body: AssignPlanDto,
  ) {
    return this.tenants.assignPlan(request.platformPrincipal!, id, body);
  }

  @Post(":id/subscription/addons")
  @RequirePlatformCapabilities("tenants.write", "billing.write")
  assignAddon(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(tenantReferenceSchema)) id: string,
    @Body(new ZodValidationPipe(assignAddonSchema)) body: AssignAddonDto,
  ) {
    return this.tenants.assignAddon(request.platformPrincipal!, id, body);
  }
}
