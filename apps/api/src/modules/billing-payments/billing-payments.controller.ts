import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
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
  list(@Query("tenantId") tenantId?: string) {
    return this.payments.list(tenantId);
  }

  @Post("invoices/:invoiceId")
  @RequirePlatformCapabilities("billing.write")
  record(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("invoiceId", new ZodValidationPipe(invoiceIdSchema)) invoiceId: string,
    @Body(new ZodValidationPipe(manualPaymentSchema)) body: ManualPaymentDto,
  ) {
    return this.payments.recordManual(req.platformPrincipal!, invoiceId, body);
  }

  @Post("imports")
  @RequirePlatformCapabilities("billing.write")
  import(
    @Req() req: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(importBankFileSchema)) body: ImportBankFileDto,
  ) {
    return this.payments.importFile(req.platformPrincipal!, body);
  }
}
