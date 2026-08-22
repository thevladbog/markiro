import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { platformCommercialContracts } from "@markiro/platform-contracts";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { parsePlatformResponse } from "../../platform-http/platform-response";
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

const invoiceDocumentDownloadParamsPipe = new ZodValidationPipe(
  platformCommercialContracts.invoices.documents.download.params,
);

@Controller("platform/invoices")
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly documents: BillingDocumentsService,
    private readonly application: BillingApplicationService,
  ) {}

  @Get()
  @RequirePlatformCapabilities("billing.read")
  async list(@Query("tenantId") tenantId?: string) {
    return parsePlatformResponse(
      platformCommercialContracts.invoices.list.response,
      await this.billing.list(tenantId),
    );
  }

  @Get(":id")
  @RequirePlatformCapabilities("billing.read")
  async get(@Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string) {
    return parsePlatformResponse(
      platformCommercialContracts.invoices.detail.response,
      await this.billing.get(id),
    );
  }

  @Post()
  @RequirePlatformCapabilities("billing.write")
  async create(
    @Req() req: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(createInvoiceSchema)) body: CreateInvoiceDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.invoices.create.response,
      await this.billing.create(req.platformPrincipal!, body),
    );
  }

  @Post(":id/issue")
  @RequirePlatformCapabilities("billing.write")
  async issue(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string,
  ) {
    const invoice = await this.billing.issue(req.platformPrincipal!, id);
    const documents = await this.documents.renderInvoice(id);
    return parsePlatformResponse(platformCommercialContracts.invoices.issue.response, {
      ...invoice,
      documents,
    });
  }

  @Post(":id/document")
  @RequirePlatformCapabilities("billing.write")
  async document(@Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string) {
    return parsePlatformResponse(
      platformCommercialContracts.invoices.document.response,
      await this.documents.renderAndStore(id),
    );
  }

  @Get(":id/documents")
  @RequirePlatformCapabilities("billing.read")
  async documentsList(@Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string) {
    return parsePlatformResponse(
      platformCommercialContracts.invoices.documents.list.response,
      await this.documents.list(id),
    );
  }

  @Post(":id/documents")
  @RequirePlatformCapabilities("billing.write")
  async documentsRender(@Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string) {
    return parsePlatformResponse(
      platformCommercialContracts.invoices.documents.render.response,
      await this.documents.renderInvoice(id),
    );
  }

  @Get(":id/document")
  @RequirePlatformCapabilities("billing.read")
  async documentUrl(@Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string) {
    return parsePlatformResponse(
      platformCommercialContracts.invoices.documentUrl.response,
      await this.documents.url(id),
    );
  }

  @Get(":id/documents/:documentId/download")
  @RequirePlatformCapabilities("billing.read")
  async documentDownload(
    @Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string,
    @Param("documentId") documentId: string,
  ) {
    const params = {
      invoiceId: id,
      documentId,
    };
    invoiceDocumentDownloadParamsPipe.transform(params);
    return parsePlatformResponse(
      platformCommercialContracts.invoices.documents.download.response,
      await this.documents.url(params.invoiceId, params.documentId),
    );
  }

  @Post(":id/apply")
  @RequirePlatformCapabilities("billing.write")
  async apply(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string,
    @Body(new ZodValidationPipe(applyInvoiceSchema)) body: ApplyInvoiceDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.invoices.apply.response,
      await this.application.apply(req.platformPrincipal!, id, body),
    );
  }

  @Post(":id/cancel")
  @RequirePlatformCapabilities("billing.write")
  async cancel(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.invoices.cancel.response,
      await this.billing.cancel(req.platformPrincipal!, id),
    );
  }
}
