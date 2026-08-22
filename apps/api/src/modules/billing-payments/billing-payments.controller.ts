import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { platformCommercialContracts } from "@markiro/platform-contracts";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import { invoiceIdSchema } from "../billing/dto";
import {
  importBankFileSchema,
  manualPaymentSchema,
  type ImportBankFileDto,
  type ManualPaymentDto,
} from "./dto";
import { BillingPaymentsService } from "./billing-payments.service";

@Controller("platform/payments")
export class BillingPaymentsController {
  constructor(private readonly payments: BillingPaymentsService) {}

  @Get()
  @RequirePlatformCapabilities("billing.read")
  async list(@Query("tenantId") tenantId?: string) {
    return parsePlatformResponse(
      platformCommercialContracts.payments.list.response,
      await this.payments.list(tenantId),
    );
  }

  @Post("invoices/:invoiceId")
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
