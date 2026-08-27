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
import { memoryStorage } from "multer";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
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
  requestAttachmentParamsSchema,
  requestReplySchema,
  type CreateBillingRequestDto,
  type ListDocumentsQueryDto,
  type ListInvoicesQueryDto,
  type OfferAcceptDto,
  type OfferChangeRequestDto,
  type RequestReplyDto,
} from "./dto";
import { BillingAttachmentUploadFilter } from "./billing-attachment-upload.filter";
import { TenantBillingOffersService } from "./tenant-billing-offers.service";
import { TenantBillingReadService } from "./tenant-billing-read.service";
import { TenantBillingRequestsService } from "./tenant-billing-requests.service";

@Controller("billing")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@RequirePermissions(CABINET_CAPABILITY.BILLING_READ)
export class TenantBillingController {
  constructor(
    private readonly billing: TenantBillingReadService,
    private readonly requests: TenantBillingRequestsService,
    private readonly offers: TenantBillingOffersService,
  ) {}

  @Get("overview")
  overview(@Req() req: RequestWithTenant) {
    return this.billing.overview(req.tenantId!);
  }

  @Get("subscription")
  subscription(@Req() req: RequestWithTenant) {
    return this.billing.subscription(req.tenantId!);
  }

  @Get("invoices")
  listInvoices(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listInvoicesQuerySchema)) query: ListInvoicesQueryDto,
  ) {
    return this.billing.listInvoices(req.tenantId!, query);
  }

  @Get("invoices/:id")
  invoiceDetail(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(billingIdParamsSchema)) params: { id: string },
  ) {
    return this.billing.invoiceDetail(req.tenantId!, params.id);
  }

  @Get("invoices/:id/documents/:documentId/download")
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
  listDocuments(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listDocumentsQuerySchema)) query: ListDocumentsQueryDto,
  ) {
    return this.billing.listDocuments(req.tenantId!, query);
  }

  @Get("offers/:id")
  offerDetail(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(billingIdParamsSchema)) params: { id: string },
  ) {
    return this.billing.offerDetail(req.tenantId!, params.id);
  }

  @Get("offers/:id/documents/:documentId/download")
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
  @AllowSubscriptionReadOnly("read")
  @RequirePermissions(CABINET_CAPABILITY.BILLING_REQUEST)
  createRequest(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createBillingRequestSchema)) body: CreateBillingRequestDto,
  ) {
    return this.requests.create(req.tenantId!, req.userId!, body);
  }

  @Get("requests")
  listRequests(@Req() req: RequestWithTenant) {
    return this.requests.list(req.tenantId!);
  }

  @Get("requests/:id")
  requestDetail(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(billingIdParamsSchema)) params: { id: string },
  ) {
    return this.requests.detail(req.tenantId!, params.id);
  }

  @Post("requests/:id/replies")
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
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 2 },
    }),
  )
  @UseFilters(BillingAttachmentUploadFilter)
  @AllowSubscriptionReadOnly("read")
  @RequirePermissions(CABINET_CAPABILITY.BILLING_REQUEST)
  attachToRequest(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(billingIdParamsSchema)) params: { id: string },
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException({ code: "billing_attachment_required" });
    return this.requests.attach(req.tenantId!, req.userId!, params.id, file);
  }

  @Get("requests/:id/attachments/:attachmentId/download")
  downloadRequestAttachment(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(requestAttachmentParamsSchema))
    params: { id: string; attachmentId: string },
  ) {
    return this.requests.downloadAttachment(req.tenantId!, params.id, params.attachmentId);
  }

  @Post("offers/:id/accept")
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
