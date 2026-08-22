import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { platformCommercialContracts } from "@markiro/platform-contracts";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  createOfferSchema,
  offerIdSchema,
  paymentSchema,
  type CreateOfferDto,
  type PaymentDto,
} from "./dto";
import { PlatformOffersService } from "./platform-offers.service";
import { OfferDocumentsService } from "./offer-documents.service";

const offerDocumentDownloadParamsPipe = new ZodValidationPipe(
  platformCommercialContracts.offers.documents.download.params,
);

@Controller("platform/offers")
export class PlatformOffersController {
  constructor(
    private readonly offers: PlatformOffersService,
    private readonly documents: OfferDocumentsService,
  ) {}

  @Get()
  @RequirePlatformCapabilities("billing.read")
  async list(@Req() req: RequestWithPlatformPrincipal, @Query("tenantId") tenantId?: string) {
    return parsePlatformResponse(
      platformCommercialContracts.offers.list.response,
      await this.offers.list(req.platformPrincipal!, tenantId),
    );
  }

  @Get(":id")
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
  @RequirePlatformCapabilities("billing.write")
  async publish(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(offerIdSchema)) id: string,
  ) {
    const offer = await this.offers.publish(req.platformPrincipal!, id);
    const documents = await this.documents.render(id);
    return parsePlatformResponse(platformCommercialContracts.offers.publish.response, {
      ...offer,
      documents,
    });
  }

  @Get(":id/documents")
  @RequirePlatformCapabilities("billing.read")
  async documentsList(@Param("id", new ZodValidationPipe(offerIdSchema)) id: string) {
    return parsePlatformResponse(
      platformCommercialContracts.offers.documents.list.response,
      await this.documents.list(id),
    );
  }

  @Post(":id/documents")
  @RequirePlatformCapabilities("billing.write")
  async documentsRender(@Param("id", new ZodValidationPipe(offerIdSchema)) id: string) {
    return parsePlatformResponse(
      platformCommercialContracts.offers.documents.render.response,
      await this.documents.render(id),
    );
  }

  @Get(":id/documents/:documentId/download")
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
