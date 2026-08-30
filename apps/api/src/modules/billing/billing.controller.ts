import { Body, Controller, Delete, Get, Param, Post, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { platformCommercialContracts } from "@markiro/platform-contracts";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import {
  PlatformApiProtectedCreated,
  PlatformApiProtectedOk,
} from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import { BillingService } from "./billing.service";
import { BillingDocumentsService } from "./billing-documents.service";
import { BillingApplicationService } from "./billing-application.service";
import {
  applyInvoiceSchema,
  createInvoiceSchema,
  invoicePrintGenerationSchema,
  invoiceIdSchema,
  type ApplyInvoiceDto,
  type CreateInvoiceDto,
  type InvoicePrintGenerationDto,
} from "./dto";

const invoiceDocumentDownloadParamsPipe = new ZodValidationPipe(
  platformCommercialContracts.invoices.documents.download.params,
);

@ApiTags("billing")
@Controller("platform/invoices")
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly documents: BillingDocumentsService,
    private readonly application: BillingApplicationService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List invoices" })
  @ApiQuery({ name: "tenantId", required: false, schema: { type: "string" } })
  @PlatformApiProtectedOk({ response: platformCommercialContracts.invoices.list.response })
  @RequirePlatformCapabilities("billing.read")
  async list(@Query("tenantId") tenantId?: string) {
    return parsePlatformResponse(
      platformCommercialContracts.invoices.list.response,
      await this.billing.list(tenantId),
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "Get an invoice" })
  @PlatformApiProtectedOk({ response: platformCommercialContracts.invoices.detail.response })
  @RequirePlatformCapabilities("billing.read")
  async get(@Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string) {
    return parsePlatformResponse(
      platformCommercialContracts.invoices.detail.response,
      await this.billing.get(id),
    );
  }

  @Post()
  @ApiOperation({ summary: "Create a draft invoice" })
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.invoices.create.body,
    response: platformCommercialContracts.invoices.create.response,
  })
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
  @ApiOperation({ summary: "Issue an invoice" })
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.invoices.issue.body,
    response: platformCommercialContracts.invoices.issue.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async issue(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string,
    @Body(new ZodValidationPipe(invoicePrintGenerationSchema)) body: InvoicePrintGenerationDto,
  ) {
    const invoice = await this.billing.issue(req.platformPrincipal!, id);
    const documents = await this.documents.renderInvoice(id, undefined, body.printVariant);
    return parsePlatformResponse(platformCommercialContracts.invoices.issue.response, {
      ...invoice,
      documents,
    });
  }

  @Post(":id/document")
  @ApiOperation({ summary: "Render and store the invoice document" })
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.invoices.document.body,
    response: platformCommercialContracts.invoices.document.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async document(
    @Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string,
    @Body(new ZodValidationPipe(invoicePrintGenerationSchema)) body: InvoicePrintGenerationDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.invoices.document.response,
      await this.documents.renderAndStore(id, body.printVariant),
    );
  }

  @Get(":id/documents")
  @ApiOperation({ summary: "List invoice documents" })
  @PlatformApiProtectedOk({
    response: platformCommercialContracts.invoices.documents.list.response,
  })
  @RequirePlatformCapabilities("billing.read")
  async documentsList(@Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string) {
    return parsePlatformResponse(
      platformCommercialContracts.invoices.documents.list.response,
      await this.documents.list(id),
    );
  }

  @Post(":id/documents")
  @ApiOperation({ summary: "Render invoice documents" })
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.invoices.documents.render.body,
    response: platformCommercialContracts.invoices.documents.render.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async documentsRender(
    @Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string,
    @Body(new ZodValidationPipe(invoicePrintGenerationSchema)) body: InvoicePrintGenerationDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.invoices.documents.render.response,
      await this.documents.renderInvoice(id, undefined, body.printVariant),
    );
  }

  @Get(":id/document")
  @ApiOperation({ summary: "Get the invoice document URL" })
  @PlatformApiProtectedOk({ response: platformCommercialContracts.invoices.documentUrl.response })
  @RequirePlatformCapabilities("billing.read")
  async documentUrl(@Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string) {
    return parsePlatformResponse(
      platformCommercialContracts.invoices.documentUrl.response,
      await this.documents.url(id),
    );
  }

  @Get(":id/documents/:documentId/download")
  @ApiOperation({ summary: "Get an invoice document download URL" })
  @PlatformApiProtectedOk({
    response: platformCommercialContracts.invoices.documents.download.response,
  })
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
  @ApiOperation({ summary: "Apply a paid invoice" })
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.invoices.apply.body,
    response: platformCommercialContracts.invoices.apply.response,
  })
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
  @ApiOperation({ summary: "Cancel an invoice" })
  @PlatformApiProtectedCreated({ response: platformCommercialContracts.invoices.cancel.response })
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

  @Delete(":id")
  @ApiOperation({ summary: "Delete a draft invoice" })
  @PlatformApiProtectedOk({ response: platformCommercialContracts.invoices.delete.response })
  @RequirePlatformCapabilities("billing.write")
  async deleteDraft(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(invoiceIdSchema)) id: string,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.invoices.delete.response,
      await this.billing.deleteDraft(req.platformPrincipal!, id),
    );
  }
}
