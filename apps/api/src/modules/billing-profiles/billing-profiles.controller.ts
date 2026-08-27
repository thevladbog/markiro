import { Body, Controller, Get, Param, Put, Req, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { platformCommercialContracts } from "@markiro/platform-contracts";
import type { Response } from "express";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { PlatformApiProtectedOk } from "../../platform-http/platform-openapi";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  billingProfileSchema,
  operatorBillingProfileInputSchema,
  operatorBillingProfileResponseSchema,
  tenantBillingProfileResponseSchema,
  type BillingProfileInput,
  type OperatorBillingProfileInput,
} from "./dto";
import { BillingProfilesService } from "./billing-profiles.service";

@ApiTags("billing-profiles")
@Controller("platform/billing")
export class BillingProfilesController {
  constructor(private readonly profiles: BillingProfilesService) {}

  @Get("operator-profile")
  @ApiOperation({ summary: "Get operator billing profile" })
  @PlatformApiProtectedOk({
    response: platformCommercialContracts.billingProfiles.operator.get.response,
  })
  @RequirePlatformCapabilities("billing.read")
  async getOperator(@Res() response: Response) {
    const profile = operatorBillingProfileResponseSchema
      .nullable()
      .parse(await this.profiles.getOperator());
    return response.json(profile);
  }

  @Put("operator-profile")
  @ApiOperation({ summary: "Set operator billing profile" })
  @PlatformApiProtectedOk({
    body: platformCommercialContracts.billingProfiles.operator.set.body,
    response: platformCommercialContracts.billingProfiles.operator.set.response,
  })
  @RequirePlatformCapabilities("billing.write")
  setOperator(
    @Req() request: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(operatorBillingProfileInputSchema))
    body: OperatorBillingProfileInput,
  ) {
    return this.profiles
      .setOperator(request.platformPrincipal!, body)
      .then((profile) => operatorBillingProfileResponseSchema.parse(profile));
  }

  @Get("tenants/:tenantId/profile")
  @ApiOperation({ summary: "Get tenant billing profile" })
  @PlatformApiProtectedOk({
    response: platformCommercialContracts.billingProfiles.tenant.get.response,
  })
  @RequirePlatformCapabilities("billing.read")
  async getTenant(@Param("tenantId") tenantId: string, @Res() response: Response) {
    const profile = tenantBillingProfileResponseSchema
      .nullable()
      .parse(await this.profiles.getTenant(tenantId));
    return response.json(profile);
  }

  @Put("tenants/:tenantId/profile")
  @ApiOperation({ summary: "Set tenant billing profile" })
  @PlatformApiProtectedOk({
    body: platformCommercialContracts.billingProfiles.tenant.set.body,
    response: platformCommercialContracts.billingProfiles.tenant.set.response,
  })
  @RequirePlatformCapabilities("billing.write")
  setTenant(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId") tenantId: string,
    @Body(new ZodValidationPipe(billingProfileSchema)) body: BillingProfileInput,
  ) {
    return this.profiles
      .setTenant(request.platformPrincipal!, tenantId, body)
      .then((profile) => tenantBillingProfileResponseSchema.parse(profile));
  }
}
