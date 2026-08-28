import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { memoryStorage } from "multer";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodBody,
  ApiZodQuery,
  ApiZodResponse,
} from "../../lib/openapi";
import { AllowSubscriptionReadOnly } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  actDocumentParamsSchema,
  billingIdParamsSchema,
  createBillingRequestSchema,
  invoiceDocumentParamsSchema,
  listDocumentsQuerySchema,
  listInvoicesQuerySchema,
  offerAcceptSchema,
  offerChangeRequestSchema,
  offerDocumentParamsSchema,
  privateDownloadSchema,
  requestAttachmentParamsSchema,
  requestAttachmentUploadSchema,
  requestReplySchema,
  tenantBillingAttentionSchema,
  tenantBillingOverviewSchema,
  tenantBillingRequestAttachmentSchema,
  tenantBillingRequestDetailSchema,
  tenantBillingRequestEventSchema,
  tenantBillingRequestListSchema,
  tenantDocumentListSchema,
  tenantInvoiceDetailSchema,
  tenantInvoiceListSchema,
  tenantOfferDecisionSchema,
  tenantOfferDetailSchema,
  tenantSubscriptionBillingSchema,
  type CreateBillingRequestDto,
  type ListDocumentsQueryDto,
  type ListInvoicesQueryDto,
  type OfferAcceptDto,
  type OfferChangeRequestDto,
  type RequestReplyDto,
  type RequestAttachmentUploadDto,
} from "./dto";
import { BillingAttachmentUploadFilter } from "./billing-attachment-upload.filter";
import { TenantBillingOffersService } from "./tenant-billing-offers.service";
import { TenantBillingNotificationsService } from "./tenant-billing-notifications.service";
import { TenantBillingReadService } from "./tenant-billing-read.service";
import { TenantBillingRequestsService } from "./tenant-billing-requests.service";

@ApiTags("tenant-billing")
@ApiCabinetAuth()
@Controller("billing")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@RequirePermissions(CABINET_CAPABILITY.BILLING_READ)
export class TenantBillingController {
  constructor(
    private readonly billing: TenantBillingReadService,
    private readonly requests: TenantBillingRequestsService,
    private readonly offers: TenantBillingOffersService,
    private readonly notifications: TenantBillingNotificationsService,
  ) {}

  @Get("overview")
  @ApiOperation({ summary: "Read the tenant billing overview" })
  @ApiZodResponse({ status: 200, schema: tenantBillingOverviewSchema })
  @ApiHttpErrors(401, 403, 409)
  overview(@Req() req: RequestWithTenant) {
    return this.billing.overview(req.tenantId!);
  }

  @Get("subscription")
  @ApiOperation({ summary: "Read the tenant subscription and limits" })
  @ApiZodResponse({ status: 200, schema: tenantSubscriptionBillingSchema })
  @ApiHttpErrors(401, 403, 409)
  subscription(@Req() req: RequestWithTenant) {
    return this.billing.subscription(req.tenantId!);
  }

  @Get("attention")
  @ApiOperation({ summary: "Read the tenant billing attention count" })
  @ApiZodResponse({ status: 200, schema: tenantBillingAttentionSchema })
  @ApiHttpErrors(401, 403, 409)
  attention(@Req() req: RequestWithTenant) {
    return this.notifications.attention(req.tenantId!);
  }

  @Get("invoices")
  @ApiOperation({ summary: "List tenant invoices" })
  @ApiZodQuery(listInvoicesQuerySchema)
  @ApiZodResponse({ status: 200, schema: tenantInvoiceListSchema })
  @ApiHttpErrors(400, 401, 403, 409)
  listInvoices(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listInvoicesQuerySchema)) query: ListInvoicesQueryDto,
  ) {
    return this.billing.listInvoices(req.tenantId!, query);
  }

  @Get("invoices/:id")
  @ApiOperation({ summary: "Read a tenant invoice" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodResponse({ status: 200, schema: tenantInvoiceDetailSchema })
  @ApiHttpErrors(400, 401, 403, 404, 409)
  invoiceDetail(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(billingIdParamsSchema)) params: { id: string },
  ) {
    return this.billing.invoiceDetail(req.tenantId!, params.id);
  }

  @Get("invoices/:id/documents/:documentId/download")
  @ApiOperation({ summary: "Get an invoice document download link" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiParam({ name: "documentId", schema: { type: "string", format: "uuid" } })
  @ApiZodResponse({ status: 200, schema: privateDownloadSchema })
  @ApiHttpErrors(400, 401, 403, 404, 409)
  downloadInvoiceDocument(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(invoiceDocumentParamsSchema))
    params: {
      id: string;
      documentId: string;
    },
  ) {
    return this.billing.downloadInvoiceDocument(req.tenantId!, params.id, params.documentId);
  }

  @Get("documents")
  @ApiOperation({ summary: "List tenant acts and offer documents" })
  @ApiZodQuery(listDocumentsQuerySchema)
  @ApiZodResponse({ status: 200, schema: tenantDocumentListSchema })
  @ApiHttpErrors(400, 401, 403, 409)
  listDocuments(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listDocumentsQuerySchema)) query: ListDocumentsQueryDto,
  ) {
    return this.billing.listDocuments(req.tenantId!, query);
  }

  @Get("offers/:id")
  @ApiOperation({ summary: "Read a tenant commercial offer" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodResponse({ status: 200, schema: tenantOfferDetailSchema })
  @ApiHttpErrors(400, 401, 403, 404, 409)
  offerDetail(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(billingIdParamsSchema)) params: { id: string },
  ) {
    return this.billing.offerDetail(req.tenantId!, params.id);
  }

  @Get("offers/:id/documents/:documentId/download")
  @ApiOperation({ summary: "Get an offer document download link" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiParam({ name: "documentId", schema: { type: "string", format: "uuid" } })
  @ApiZodResponse({ status: 200, schema: privateDownloadSchema })
  @ApiHttpErrors(400, 401, 403, 404, 409)
  downloadOfferDocument(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(offerDocumentParamsSchema))
    params: {
      id: string;
      documentId: string;
    },
  ) {
    return this.billing.downloadOfferDocument(req.tenantId!, params.id, params.documentId);
  }

  @Get("acts/:id/documents/:documentId/download")
  @ApiOperation({ summary: "Get an act document download link" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiParam({ name: "documentId", schema: { type: "string", format: "uuid" } })
  @ApiZodResponse({ status: 200, schema: privateDownloadSchema })
  @ApiHttpErrors(400, 401, 403, 404, 409)
  downloadActDocument(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(actDocumentParamsSchema))
    params: {
      id: string;
      documentId: string;
    },
  ) {
    return this.billing.downloadActDocument(req.tenantId!, params.id, params.documentId);
  }

  @Post("requests")
  @ApiOperation({ summary: "Create a tenant billing request" })
  @ApiZodBody(createBillingRequestSchema)
  @ApiZodResponse({ status: 201, schema: tenantBillingRequestDetailSchema })
  @ApiHttpErrors(400, 401, 403, 409)
  @AllowSubscriptionReadOnly("read")
  @RequirePermissions(CABINET_CAPABILITY.BILLING_REQUEST)
  createRequest(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createBillingRequestSchema)) body: CreateBillingRequestDto,
  ) {
    return this.requests.create(req.tenantId!, req.userId!, body);
  }

  @Get("requests")
  @ApiOperation({ summary: "List tenant billing requests" })
  @ApiZodResponse({ status: 200, schema: tenantBillingRequestListSchema })
  @ApiHttpErrors(401, 403, 409)
  listRequests(@Req() req: RequestWithTenant) {
    return this.requests.list(req.tenantId!);
  }

  @Get("requests/:id")
  @ApiOperation({ summary: "Read a tenant billing request" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodResponse({ status: 200, schema: tenantBillingRequestDetailSchema })
  @ApiHttpErrors(400, 401, 403, 404, 409)
  requestDetail(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(billingIdParamsSchema)) params: { id: string },
  ) {
    return this.requests.detail(req.tenantId!, params.id);
  }

  @Post("requests/:id/replies")
  @ApiOperation({ summary: "Reply to a tenant billing request" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(requestReplySchema)
  @ApiZodResponse({ status: 201, schema: tenantBillingRequestEventSchema })
  @ApiHttpErrors(400, 401, 403, 404, 409)
  @AllowSubscriptionReadOnly("read")
  @RequirePermissions(CABINET_CAPABILITY.BILLING_REQUEST)
  replyToRequest(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(billingIdParamsSchema)) params: { id: string },
    @Body(new ZodValidationPipe(requestReplySchema)) body: RequestReplyDto,
  ) {
    return this.requests.reply(req.tenantId!, req.userId!, params.id, body);
  }

  @Post("requests/:id/attachments")
  @ApiOperation({ summary: "Upload an attachment to a tenant billing request" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 1, parts: 2 },
    }),
  )
  @UseFilters(BillingAttachmentUploadFilter)
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["idempotencyKey", "file"],
      properties: {
        idempotencyKey: { type: "string", format: "uuid" },
        file: { type: "string", format: "binary" },
      },
    },
  })
  @ApiZodResponse({ status: 201, schema: tenantBillingRequestAttachmentSchema })
  @ApiHttpErrors(400, 401, 403, 404, 409, 413, 415)
  @AllowSubscriptionReadOnly("read")
  @RequirePermissions(CABINET_CAPABILITY.BILLING_REQUEST)
  attachToRequest(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(billingIdParamsSchema)) params: { id: string },
    @Body(new ZodValidationPipe(requestAttachmentUploadSchema)) body: RequestAttachmentUploadDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException({ code: "billing_attachment_required" });
    return this.requests.attach(req.tenantId!, req.userId!, params.id, body.idempotencyKey, file);
  }

  @Get("requests/:id/attachments/:attachmentId/download")
  @ApiOperation({ summary: "Get a billing request attachment download link" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiParam({ name: "attachmentId", schema: { type: "string", format: "uuid" } })
  @ApiZodResponse({ status: 200, schema: privateDownloadSchema })
  @ApiHttpErrors(400, 401, 403, 404, 409)
  downloadRequestAttachment(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(requestAttachmentParamsSchema))
    params: { id: string; attachmentId: string },
  ) {
    return this.requests.downloadAttachment(req.tenantId!, params.id, params.attachmentId);
  }

  @Post("offers/:id/accept")
  @ApiOperation({ summary: "Accept a tenant commercial offer" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(offerAcceptSchema)
  @ApiZodResponse({ status: 201, schema: tenantOfferDecisionSchema })
  @ApiHttpErrors(400, 401, 403, 404, 409)
  @AllowSubscriptionReadOnly("read")
  @RequirePermissions(CABINET_CAPABILITY.BILLING_REQUEST)
  acceptOffer(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(billingIdParamsSchema)) params: { id: string },
    @Body(new ZodValidationPipe(offerAcceptSchema)) body: OfferAcceptDto,
  ) {
    return this.offers.accept(req.tenantId!, req.userId!, params.id, body.idempotencyKey);
  }

  @Post("offers/:id/change-request")
  @ApiOperation({ summary: "Request changes to a tenant commercial offer" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(offerChangeRequestSchema)
  @ApiZodResponse({ status: 201, schema: tenantOfferDecisionSchema })
  @ApiHttpErrors(400, 401, 403, 404, 409)
  @AllowSubscriptionReadOnly("read")
  @RequirePermissions(CABINET_CAPABILITY.BILLING_REQUEST)
  requestOfferChanges(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(billingIdParamsSchema)) params: { id: string },
    @Body(new ZodValidationPipe(offerChangeRequestSchema)) body: OfferChangeRequestDto,
  ) {
    return this.offers.requestChanges(req.tenantId!, req.userId!, params.id, body);
  }
}
