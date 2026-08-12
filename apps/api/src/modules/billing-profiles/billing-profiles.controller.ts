import { Body, Controller, Get, Param, Put, Req } from "@nestjs/common";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { billingProfileSchema, type BillingProfileInput } from "./dto";
import { BillingProfilesService } from "./billing-profiles.service";

@Controller("platform/billing")
export class BillingProfilesController {
  constructor(private readonly profiles: BillingProfilesService) {}

  @Get("operator-profile")
  @RequirePlatformCapabilities("billing.read")
  getOperator() {
    return this.profiles.getOperator();
  }

  @Put("operator-profile")
  @RequirePlatformCapabilities("billing.write")
  setOperator(
    @Req() request: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(billingProfileSchema)) body: BillingProfileInput,
  ) {
    return this.profiles.setOperator(request.platformPrincipal!, body);
  }

  @Get("tenants/:tenantId/profile")
  @RequirePlatformCapabilities("billing.read")
  getTenant(@Param("tenantId") tenantId: string) {
    return this.profiles.getTenant(tenantId);
  }

  @Put("tenants/:tenantId/profile")
  @RequirePlatformCapabilities("billing.write")
  setTenant(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId") tenantId: string,
    @Body(new ZodValidationPipe(billingProfileSchema)) body: BillingProfileInput,
  ) {
    return this.profiles.setTenant(request.platformPrincipal!, tenantId, body);
  }
}
