import { Body, Controller, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { platformCommercialContracts } from "@markiro/platform-contracts";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import {
  PlatformApiProtectedCreated,
  PlatformApiProtectedOk,
} from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import { invoiceIdSchema } from "../billing/dto";
import {
  importBankFileSchema,
  manualPaymentSchema,
  paymentMatchIdSchema,
  paymentMatchResolveSchema,
  type ImportBankFileDto,
  type ManualPaymentDto,
  type PaymentMatchResolveDto,
} from "./dto";
import { BillingPaymentsService } from "./billing-payments.service";

@Controller("platform/payments")
export class BillingPaymentsController {
  constructor(private readonly payments: BillingPaymentsService) {}

  @Get()
  @PlatformApiProtectedOk({ response: platformCommercialContracts.payments.list.response })
  @RequirePlatformCapabilities("billing.read")
  async list(@Query("tenantId") tenantId?: string) {
    return parsePlatformResponse(
      platformCommercialContracts.payments.list.response,
      await this.payments.list(tenantId),
    );
  }

  @Get("matches")
  @PlatformApiProtectedOk({ response: platformCommercialContracts.payments.matches.list.response })
  @RequirePlatformCapabilities("billing.read")
  async listMatches(@Query("tenantId") tenantId?: string) {
    return parsePlatformResponse(
      platformCommercialContracts.payments.matches.list.response,
      await this.payments.listMatches(tenantId),
    );
  }

  @Patch("matches/:matchId")
  @PlatformApiProtectedOk({
    body: platformCommercialContracts.payments.matches.resolve.body,
    response: platformCommercialContracts.payments.matches.resolve.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async resolveMatch(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("matchId", new ZodValidationPipe(paymentMatchIdSchema)) matchId: string,
    @Body(new ZodValidationPipe(paymentMatchResolveSchema)) body: PaymentMatchResolveDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.payments.matches.resolve.response,
      await this.payments.resolveMatch(req.platformPrincipal!, matchId, body),
    );
  }

  @Post("invoices/:invoiceId")
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.payments.manual.body,
    response: platformCommercialContracts.payments.manual.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async record(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("invoiceId", new ZodValidationPipe(invoiceIdSchema)) invoiceId: string,
    @Body(new ZodValidationPipe(manualPaymentSchema)) body: ManualPaymentDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.payments.manual.response,
      await this.payments.recordManual(req.platformPrincipal!, invoiceId, body),
    );
  }

  @Post("imports")
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.payments.import.body,
    response: platformCommercialContracts.payments.import.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async import(
    @Req() req: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(importBankFileSchema)) body: ImportBankFileDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.payments.import.response,
      await this.payments.importFile(req.platformPrincipal!, body),
    );
  }
}
