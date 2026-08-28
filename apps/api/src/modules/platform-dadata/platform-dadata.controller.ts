import { Controller, Get, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { platformCommercialContracts } from "@markiro/platform-contracts";

import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { PlatformApiProtectedOk } from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import { dadataSuggestionQuerySchema, type DadataSuggestionQuery } from "./dto";
import { PlatformDadataRateLimit } from "./platform-dadata-rate-limit";
import { PlatformDadataService } from "./platform-dadata.service";

@ApiTags("platform-dadata")
@Controller("platform/suggestions")
export class PlatformDadataController {
  constructor(
    private readonly dadata: PlatformDadataService,
    private readonly rateLimit: PlatformDadataRateLimit,
  ) {}

  @Get("organizations")
  @ApiOperation({ summary: "Suggest organizations via DaData" })
  @PlatformApiProtectedOk({ response: platformCommercialContracts.dadata.organizations.response })
  @RequirePlatformCapabilities("billing.read")
  async organizations(
    @Req() request: RequestWithPlatformPrincipal,
    @Query(new ZodValidationPipe(dadataSuggestionQuerySchema)) query: DadataSuggestionQuery,
  ) {
    this.rateLimit.consume(request.platformPrincipal!.userId);
    return parsePlatformResponse(
      platformCommercialContracts.dadata.organizations.response,
      await this.dadata.organizations(query.q),
    );
  }

  @Get("addresses")
  @ApiOperation({ summary: "Suggest addresses via DaData" })
  @PlatformApiProtectedOk({ response: platformCommercialContracts.dadata.addresses.response })
  @RequirePlatformCapabilities("billing.read")
  async addresses(
    @Req() request: RequestWithPlatformPrincipal,
    @Query(new ZodValidationPipe(dadataSuggestionQuerySchema)) query: DadataSuggestionQuery,
  ) {
    this.rateLimit.consume(request.platformPrincipal!.userId);
    return parsePlatformResponse(
      platformCommercialContracts.dadata.addresses.response,
      await this.dadata.addresses(query.q),
    );
  }

  @Get("banks")
  @ApiOperation({ summary: "Suggest banks via DaData" })
  @PlatformApiProtectedOk({ response: platformCommercialContracts.dadata.banks.response })
  @RequirePlatformCapabilities("billing.read")
  async banks(
    @Req() request: RequestWithPlatformPrincipal,
    @Query(new ZodValidationPipe(dadataSuggestionQuerySchema)) query: DadataSuggestionQuery,
  ) {
    this.rateLimit.consume(request.platformPrincipal!.userId);
    return parsePlatformResponse(
      platformCommercialContracts.dadata.banks.response,
      await this.dadata.banks(query.q),
    );
  }

  @Get("status")
  @ApiOperation({ summary: "Get DaData integration status" })
  @PlatformApiProtectedOk({ response: platformCommercialContracts.dadata.status.response })
  @RequirePlatformCapabilities()
  status() {
    return parsePlatformResponse(
      platformCommercialContracts.dadata.status.response,
      this.dadata.status(),
    );
  }
}
