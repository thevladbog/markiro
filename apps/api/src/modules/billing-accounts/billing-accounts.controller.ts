import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { platformCommercialContracts } from "@markiro/platform-contracts";

import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import {
  PlatformApiProtectedCreated,
  PlatformApiProtectedOk,
} from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import { BillingAccountsService } from "./billing-accounts.service";
import {
  bankAccountArchiveSchema,
  bankAccountInputSchema,
  platformTenantIdSchema,
  platformUuidSchema,
  type BankAccountArchiveInput,
  type BankAccountInput,
} from "./dto";

@Controller("platform/billing")
export class BillingAccountsController {
  constructor(private readonly accounts: BillingAccountsService) {}

  @Get("operator/accounts")
  @PlatformApiProtectedOk({
    response: platformCommercialContracts.billingAccounts.operator.list.response,
  })
  @RequirePlatformCapabilities("billing.read")
  async listOperator() {
    return parsePlatformResponse(
      platformCommercialContracts.billingAccounts.operator.list.response,
      await this.accounts.listOperator(),
    );
  }

  @Post("operator/accounts")
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.billingAccounts.operator.create.body,
    response: platformCommercialContracts.billingAccounts.operator.create.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async createOperator(
    @Req() request: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(bankAccountInputSchema)) body: BankAccountInput,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingAccounts.operator.create.response,
      await this.accounts.createOperator(request.platformPrincipal!, body),
    );
  }

  @Patch("operator/accounts/:accountId/default")
  @PlatformApiProtectedOk({
    response: platformCommercialContracts.billingAccounts.operator.setDefault.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async setOperatorDefault(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("accountId", new ZodValidationPipe(platformUuidSchema)) accountId: string,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingAccounts.operator.setDefault.response,
      await this.accounts.setOperatorDefault(request.platformPrincipal!, accountId),
    );
  }

  @Post("operator/accounts/:accountId/archive")
  @HttpCode(200)
  @PlatformApiProtectedOk({
    body: platformCommercialContracts.billingAccounts.operator.archive.body,
    response: platformCommercialContracts.billingAccounts.operator.archive.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async archiveOperator(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("accountId", new ZodValidationPipe(platformUuidSchema)) accountId: string,
    @Body(new ZodValidationPipe(bankAccountArchiveSchema)) body: BankAccountArchiveInput,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingAccounts.operator.archive.response,
      await this.accounts.archiveOperator(request.platformPrincipal!, accountId, body),
    );
  }

  @Get("tenants/:tenantId/accounts")
  @PlatformApiProtectedOk({
    response: platformCommercialContracts.billingAccounts.tenant.list.response,
  })
  @RequirePlatformCapabilities("billing.read")
  async listTenant(
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingAccounts.tenant.list.response,
      await this.accounts.listTenant(tenantId),
    );
  }

  @Post("tenants/:tenantId/accounts")
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.billingAccounts.tenant.create.body,
    response: platformCommercialContracts.billingAccounts.tenant.create.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async createTenant(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
    @Body(new ZodValidationPipe(bankAccountInputSchema)) body: BankAccountInput,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingAccounts.tenant.create.response,
      await this.accounts.createTenant(request.platformPrincipal!, tenantId, body),
    );
  }

  @Patch("tenants/:tenantId/accounts/:accountId/default")
  @PlatformApiProtectedOk({
    response: platformCommercialContracts.billingAccounts.tenant.setDefault.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async setTenantDefault(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
    @Param("accountId", new ZodValidationPipe(platformUuidSchema)) accountId: string,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingAccounts.tenant.setDefault.response,
      await this.accounts.setTenantDefault(request.platformPrincipal!, tenantId, accountId),
    );
  }

  @Post("tenants/:tenantId/accounts/:accountId/archive")
  @HttpCode(200)
  @PlatformApiProtectedOk({
    body: platformCommercialContracts.billingAccounts.tenant.archive.body,
    response: platformCommercialContracts.billingAccounts.tenant.archive.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async archiveTenant(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
    @Param("accountId", new ZodValidationPipe(platformUuidSchema)) accountId: string,
    @Body(new ZodValidationPipe(bankAccountArchiveSchema)) body: BankAccountArchiveInput,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingAccounts.tenant.archive.response,
      await this.accounts.archiveTenant(request.platformPrincipal!, tenantId, accountId, body),
    );
  }
}
