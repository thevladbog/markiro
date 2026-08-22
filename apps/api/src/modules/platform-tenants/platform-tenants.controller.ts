import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { platformTenantContracts } from "@markiro/platform-contracts";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import {
  PlatformApiProtectedCreated,
  PlatformApiProtectedOk,
} from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
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
  @PlatformApiProtectedOk({ response: platformTenantContracts.list.response })
  @RequirePlatformCapabilities("tenants.read")
  async list(
    @Req() request: RequestWithPlatformPrincipal,
    @Query(new ZodValidationPipe(tenantListQuerySchema)) query: TenantListQueryDto,
  ) {
    return parsePlatformResponse(
      platformTenantContracts.list.response,
      await this.tenants.list(request.platformPrincipal!, query),
    );
  }

  @Post()
  @PlatformApiProtectedCreated({
    body: platformTenantContracts.create.body,
    response: platformTenantContracts.create.response,
  })
  @RequirePlatformCapabilities("tenants.write")
  async create(
    @Req() request: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(provisionTenantSchema)) body: ProvisionTenantDto,
  ) {
    return parsePlatformResponse(
      platformTenantContracts.create.response,
      await this.tenants.create(request.platformPrincipal!, body),
    );
  }

  @Get(":id")
  @PlatformApiProtectedOk({ response: platformTenantContracts.detail.response })
  @RequirePlatformCapabilities("tenants.read")
  async get(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(tenantReferenceSchema)) id: string,
  ) {
    return parsePlatformResponse(
      platformTenantContracts.detail.response,
      await this.tenants.get(request.platformPrincipal!, id),
    );
  }

  @Post(":id/owner-activation/renew")
  @HttpCode(200)
  @PlatformApiProtectedOk({ response: platformTenantContracts.renewActivation.response })
  @RequirePlatformCapabilities("tenants.write")
  async renewActivation(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(tenantReferenceSchema)) id: string,
  ) {
    return parsePlatformResponse(
      platformTenantContracts.renewActivation.response,
      await this.tenants.renewActivation(request.platformPrincipal!, id),
    );
  }

  @Post(":id/subscription/plan")
  @PlatformApiProtectedCreated({
    body: platformTenantContracts.assignPlan.body,
    response: platformTenantContracts.assignPlan.response,
  })
  @RequirePlatformCapabilities("tenants.write", "billing.write")
  async assignPlan(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(tenantReferenceSchema)) id: string,
    @Body(new ZodValidationPipe(assignPlanSchema)) body: AssignPlanDto,
  ) {
    return parsePlatformResponse(
      platformTenantContracts.assignPlan.response,
      await this.tenants.assignPlan(request.platformPrincipal!, id, body),
    );
  }

  @Post(":id/subscription/addons")
  @PlatformApiProtectedCreated({
    body: platformTenantContracts.assignAddon.body,
    response: platformTenantContracts.assignAddon.response,
  })
  @RequirePlatformCapabilities("tenants.write", "billing.write")
  async assignAddon(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(tenantReferenceSchema)) id: string,
    @Body(new ZodValidationPipe(assignAddonSchema)) body: AssignAddonDto,
  ) {
    return parsePlatformResponse(
      platformTenantContracts.assignAddon.response,
      await this.tenants.assignAddon(request.platformPrincipal!, id, body),
    );
  }
}
