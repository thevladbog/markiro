import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  platformCommercialContracts,
  platformOfferWorkspaceContracts,
  type OfferRegistryQuery,
  type PrintDocumentVariant,
} from "@markiro/platform-contracts";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import {
  PlatformApiProtectedCreated,
  PlatformApiProtectedOk,
} from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  createOfferSchema,
  offerIdSchema,
  paymentSchema,
  reviseOfferSchema,
  type CreateOfferDto,
  type PaymentDto,
  type ReviseOfferDto,
} from "./dto";
import { PlatformOffersService } from "./platform-offers.service";
import { OfferDocumentsService } from "./offer-documents.service";
import { OfferWorkspaceService } from "./offer-workspace.service";
import { OfferPreviewService } from "./offer-preview.service";

const offerDocumentDownloadParamsPipe = new ZodValidationPipe(
  platformCommercialContracts.offers.documents.download.params,
);

@ApiTags("platform-offers")
@Controller("platform/offers")
export class PlatformOffersController {
  constructor(
    private readonly offers: PlatformOffersService,
    private readonly documents: OfferDocumentsService,
    private readonly workspaceService: OfferWorkspaceService,
    private readonly previewService: OfferPreviewService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List commercial offers" })
  @PlatformApiProtectedOk({ response: platformCommercialContracts.offers.list.response })
  @RequirePlatformCapabilities("billing.read")
  async list(@Req() req: RequestWithPlatformPrincipal, @Query("tenantId") tenantId?: string) {
    return parsePlatformResponse(
      platformCommercialContracts.offers.list.response,
      await this.offers.list(req.platformPrincipal!, tenantId),
    );
  }

  @Get("registry")
  @ApiOperation({ summary: "List the commercial offer registry" })
  @PlatformApiProtectedOk({
    response: platformOfferWorkspaceContracts.registry.response,
    query: platformOfferWorkspaceContracts.registry.query,
  })
  @RequirePlatformCapabilities("billing.read")
  async registry(
    @Req() req: RequestWithPlatformPrincipal,
    @Query(new ZodValidationPipe(platformOfferWorkspaceContracts.registry.query))
    query: OfferRegistryQuery,
  ) {
    return parsePlatformResponse(
      platformOfferWorkspaceContracts.registry.response,
      await this.workspaceService.registry(req.platformPrincipal!, query),
    );
  }

  @Get(":id/workspace")
  @ApiOperation({ summary: "Get the commercial offer workspace" })
  @PlatformApiProtectedOk({ response: platformOfferWorkspaceContracts.workspace.response })
  @RequirePlatformCapabilities("billing.read")
  async workspace(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(platformOfferWorkspaceContracts.workspace.params))
    id: string,
  ) {
    return parsePlatformResponse(
      platformOfferWorkspaceContracts.workspace.response,
      await this.workspaceService.workspace(req.platformPrincipal!, id),
    );
  }

  @Get(":id/preview")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Preview a saved commercial offer draft" })
  @PlatformApiProtectedOk({ response: platformOfferWorkspaceContracts.preview.response })
  @RequirePlatformCapabilities("billing.read")
  async preview(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(offerIdSchema)) id: string,
  ) {
    return parsePlatformResponse(
      platformOfferWorkspaceContracts.preview.response,
      await this.previewService.preview(req.platformPrincipal!, id),
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "Get commercial offer details" })
  @PlatformApiProtectedOk({ response: platformCommercialContracts.offers.detail.response })
  @RequirePlatformCapabilities("billing.read")
  async detail(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(offerIdSchema)) id: string,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.offers.detail.response,
      await this.offers.detail(req.platformPrincipal!, id),
    );
  }

  @Post()
  @ApiOperation({ summary: "Create a commercial offer" })
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.offers.create.body,
    response: platformCommercialContracts.offers.create.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async create(
    @Req() req: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(createOfferSchema)) body: CreateOfferDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.offers.create.response,
      await this.offers.create(req.platformPrincipal!, body),
    );
  }

  @Post(":id/publish")
  @HttpCode(200)
  @ApiOperation({
    summary: "Publish a commercial offer",
    description:
      "Publishing also renders the offer document package and returns it with the offer.",
  })
  @PlatformApiProtectedOk({
    body: platformCommercialContracts.offers.publish.body,
    response: platformCommercialContracts.offers.publish.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async publish(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(offerIdSchema)) id: string,
    @Body(new ZodValidationPipe(platformCommercialContracts.offers.publish.body.prefault({})))
    body: { previewFingerprint?: string } = {},
  ) {
    const offer = await this.offers.publish(req.platformPrincipal!, id, body.previewFingerprint);
    const documents = await this.documents.render(id);
    return parsePlatformResponse(platformCommercialContracts.offers.publish.response, {
      ...offer,
      documents,
    });
  }

  @Post(":id/revise")
  @ApiOperation({ summary: "Create a revised commercial offer" })
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.offers.revise.body,
    response: platformCommercialContracts.offers.revise.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async revise(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(offerIdSchema)) id: string,
    @Body(new ZodValidationPipe(reviseOfferSchema)) body: ReviseOfferDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.offers.revise.response,
      await this.offers.revise(req.platformPrincipal!, id, body),
    );
  }

  @Get(":id/documents")
  @ApiOperation({ summary: "List offer documents" })
  @PlatformApiProtectedOk({
    response: platformCommercialContracts.offers.documents.list.response,
  })
  @RequirePlatformCapabilities("billing.read")
  async documentsList(@Param("id", new ZodValidationPipe(offerIdSchema)) id: string) {
    return parsePlatformResponse(
      platformCommercialContracts.offers.documents.list.response,
      await this.documents.list(id),
    );
  }

  @Post(":id/documents")
  @ApiOperation({
    summary: "Render offer documents",
    description: "Creates or retries a print variant while retaining ready documents.",
  })
  @PlatformApiProtectedCreated({
    response: platformCommercialContracts.offers.documents.render.response,
    body: platformCommercialContracts.offers.documents.render.body,
  })
  @RequirePlatformCapabilities("billing.write")
  async documentsRender(
    @Param("id", new ZodValidationPipe(offerIdSchema)) id: string,
    @Req() req: RequestWithPlatformPrincipal,
    @Body(
      new ZodValidationPipe(platformCommercialContracts.offers.documents.render.body.prefault({})),
    )
    body: { printVariant: PrintDocumentVariant } = { printVariant: "clean" },
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.offers.documents.render.response,
      await this.documents.render(id, body.printVariant, req.platformPrincipal),
    );
  }

  @Get(":id/documents/:documentId/download")
  @ApiOperation({ summary: "Get an offer document download link" })
  @PlatformApiProtectedOk({
    response: platformCommercialContracts.offers.documents.download.response,
  })
  @RequirePlatformCapabilities("billing.read")
  async documentsDownload(
    @Param("id", new ZodValidationPipe(offerIdSchema)) id: string,
    @Param("documentId") documentId: string,
  ) {
    const params = {
      offerId: id,
      documentId,
    };
    offerDocumentDownloadParamsPipe.transform(params);
    return parsePlatformResponse(
      platformCommercialContracts.offers.documents.download.response,
      await this.documents.url(params.offerId, params.documentId),
    );
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @ApiOperation({ summary: "Cancel a commercial offer" })
  @PlatformApiProtectedOk({ response: platformCommercialContracts.offers.cancel.response })
  @RequirePlatformCapabilities("billing.write")
  async cancel(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(offerIdSchema)) id: string,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.offers.cancel.response,
      await this.offers.cancel(req.platformPrincipal!, id),
    );
  }

  @Post(":id/payment")
  @ApiOperation({
    summary: "Register a payment for an offer",
    description: "Supports an optional Idempotency-Key header to deduplicate retries.",
  })
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.offers.payment.body,
    response: platformCommercialContracts.offers.payment.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async pay(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(offerIdSchema)) id: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body(new ZodValidationPipe(paymentSchema)) body: PaymentDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.offers.payment.response,
      await this.offers.pay(req.platformPrincipal!, id, key ?? "", body),
    );
  }
}
