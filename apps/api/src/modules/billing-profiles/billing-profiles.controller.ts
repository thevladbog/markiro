import { Body, Controller, Get, Param, Put, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
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

@Controller("platform/billing")
export class BillingProfilesController {
  constructor(private readonly profiles: BillingProfilesService) {}

  @Get("operator-profile")
  @RequirePlatformCapabilities("billing.read")
  async getOperator(@Res() response: Response) {
    const profile = operatorBillingProfileResponseSchema
      .nullable()
      .parse(await this.profiles.getOperator());
    return response.json(profile);
  }

  @Put("operator-profile")
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
  @RequirePlatformCapabilities("billing.read")
  async getTenant(@Param("tenantId") tenantId: string, @Res() response: Response) {
    const profile = tenantBillingProfileResponseSchema
      .nullable()
      .parse(await this.profiles.getTenant(tenantId));
    return response.json(profile);
  }

  @Put("tenants/:tenantId/profile")
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
