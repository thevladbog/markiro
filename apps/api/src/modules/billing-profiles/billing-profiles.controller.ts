import { Body, Controller, Get, Param, Put, Req, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  platformCommercialContracts,
  platformCommercialV2Contracts,
} from "@markiro/platform-contracts";
import {
  isCommercialV2,
  commercialBody,
  commercialResponse,
} from "../../platform-http/commercial-version";
import type { Response } from "express";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { PlatformApiProtectedOk } from "../../platform-http/platform-openapi";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  billingProfileSchema,
  tenantBillingProfileResponseSchema,
  type BillingProfileInput,
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
    commercialV2: platformCommercialV2Contracts.billingProfiles.operator.get,
  })
  @RequirePlatformCapabilities("billing.read")
  async getOperator(@Res() response: Response, @Req() request?: RequestWithPlatformPrincipal) {
    const profile = commercialResponse(
      isCommercialV2(request ?? {}),
      platformCommercialContracts.billingProfiles.operator.get.response,
      platformCommercialV2Contracts.billingProfiles.operator.get.response,
      operatorProfileDto(await this.profiles.getOperator()),
    );
    return response.json(profile);
  }

  @Put("operator-profile")
  @ApiOperation({ summary: "Set operator billing profile" })
  @PlatformApiProtectedOk({
    body: platformCommercialContracts.billingProfiles.operator.set.body,
    response: platformCommercialContracts.billingProfiles.operator.set.response,
    commercialV2: platformCommercialV2Contracts.billingProfiles.operator.set,
  })
  @RequirePlatformCapabilities("billing.write")
  setOperator(@Req() request: RequestWithPlatformPrincipal, @Body() body: unknown) {
    return this.profiles
      .setOperator(
        request.platformPrincipal!,
        commercialBody(
          isCommercialV2(request)
            ? platformCommercialV2Contracts.billingProfiles.operator.set.body
            : platformCommercialContracts.billingProfiles.operator.set.body,
          body,
        ),
      )
      .then((profile) =>
        commercialResponse(
          isCommercialV2(request),
          platformCommercialContracts.billingProfiles.operator.set.response,
          platformCommercialV2Contracts.billingProfiles.operator.set.response,
          operatorProfileDto(profile),
        ),
      );
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

function operatorProfileDto<
  T extends { addressRaw?: unknown; address?: unknown; bankDetails?: unknown },
>(profile: T | null) {
  if (!profile) return null;
  const {
    addressRaw: _legacyAddressRaw,
    address: _legacyAddress,
    bankDetails: _legacyBankDetails,
    ...current
  } = profile;
  void _legacyAddressRaw;
  void _legacyAddress;
  void _legacyBankDetails;
  return current;
}
