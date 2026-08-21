import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { BillingService } from "./billing.service";
import { BillingDocumentsService } from "./billing-documents.service";
import { BillingApplicationService } from "./billing-application.service";
import {
  applyInvoiceSchema,
  createInvoiceSchema,
  invoiceIdSchema,
  type ApplyInvoiceDto,
  type CreateInvoiceDto,
} from "./dto";

@Controller("platform/invoices")
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly documents: BillingDocumentsService,
    private readonly application: BillingApplicationService,
  ) {}

  @Get()
  @RequirePlatformCapabilities("billing.read")
  list(@Query("tenantId") tenantId?: string) {
    return this.billing.list(tenantId);
  }

  @Get(":id")
  @RequirePlatformCapabilities("billing.read")
  get(@Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string) {
    return this.billing.get(id);
  }

  @Post()
  @RequirePlatformCapabilities("billing.write")
  create(
    @Req() req: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(createInvoiceSchema)) body: CreateInvoiceDto,
  ) {
    return this.billing.create(req.platformPrincipal!, body);
  }

  @Post(":id/issue")
  @RequirePlatformCapabilities("billing.write")
  issue(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string,
  ) {
    return this.billing.issue(req.platformPrincipal!, id).then(async (invoice) => {
      const documents = await this.documents.renderInvoice(id);
      return { ...invoice, documents };
    });
  }

  @Post(":id/document")
  @RequirePlatformCapabilities("billing.write")
  document(@Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string) {
    return this.documents.renderAndStore(id);
  }

  @Get(":id/documents")
  @RequirePlatformCapabilities("billing.read")
  documentsList(@Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string) {
    return this.documents.list(id);
  }

  @Post(":id/documents")
  @RequirePlatformCapabilities("billing.write")
  documentsRender(@Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string) {
    return this.documents.renderInvoice(id);
  }

  @Get(":id/document")
  @RequirePlatformCapabilities("billing.read")
  documentUrl(@Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string) {
    return this.documents.url(id);
  }

  @Get(":id/documents/:documentId/download")
  @RequirePlatformCapabilities("billing.read")
  documentDownload(
    @Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string,
    @Param("documentId") documentId: string,
  ) {
    return this.documents.url(id, documentId);
  }

  @Post(":id/apply")
  @RequirePlatformCapabilities("billing.write")
  apply(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string,
    @Body(new ZodValidationPipe(applyInvoiceSchema)) body: ApplyInvoiceDto,
  ) {
    return this.application.apply(req.platformPrincipal!, id, body);
  }

  @Post(":id/cancel")
  @RequirePlatformCapabilities("billing.write")
  cancel(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string,
  ) {
    return this.billing.cancel(req.platformPrincipal!, id);
  }
}
