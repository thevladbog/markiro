import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Post,
  Put,
  Req,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  catalogIntentViewSchema,
  catalogPublicationResultSchema,
  channelSnapshotSchema,
  channelChangeRequestSchema,
  publicationCommitRequestSchema,
  publicationIntentRequestSchema,
} from "@markiro/platform-contracts";
import { ApiZodBody, ApiZodResponse } from "../../lib/openapi";
import { CatalogPublisherRoute, type RequestWithPublisher } from "./catalog-publisher.guard";
import { CatalogService, type CatalogCaller } from "./catalog-service";
import { CatalogFault } from "./catalog-types";
@ApiTags("Release publisher")
@ApiBearerAuth("releasePublisherOidc")
@Controller("release-publisher")
export class CatalogPublisherController {
  constructor(@Inject(CatalogService) private readonly service: CatalogService | null) {}
  private async call<T>(
    request: RequestWithPublisher,
    body: (service: CatalogService, caller: CatalogCaller) => Promise<T>,
  ): Promise<T> {
    if (!this.service) throw new ServiceUnavailableException({ code: "catalog_not_ready" });
    const publisher = request.catalogPublisher;
    if (!publisher) throw new HttpException({ code: "catalog_forbidden" }, 403);
    const caller: CatalogCaller = {
      principal: { fingerprint: publisher.fingerprint, tokenHash: publisher.tokenHash },
      product: publisher.product,
      machine: true,
      expiresAt: publisher.expiresAt,
      actor: { actorPlatformUserId: null, actorRole: null, requestId: null },
    };
    try {
      return await body(this.service, caller);
    } catch (error) {
      if (error instanceof CatalogFault) {
        const status = {
          invalid_request: 400,
          forbidden: 403,
          conflict: 409,
          not_found: 404,
          not_ready: 503,
          unavailable: 503,
        }[error.code];
        throw new HttpException({ code: `catalog_${error.code}` }, status);
      }
      throw new ServiceUnavailableException({ code: "catalog_unavailable" });
    }
  }
  @Post("intents")
  @CatalogPublisherRoute()
  @ApiOperation({ summary: "Reserve immutable release identity for one pinned GitHub run" })
  @ApiZodBody(publicationIntentRequestSchema)
  @ApiZodResponse({ status: 201, schema: catalogIntentViewSchema })
  create(@Req() req: RequestWithPublisher, @Body() input: unknown) {
    return this.call(req, async (service, caller) => {
      const result = publicationIntentRequestSchema.safeParse(input);
      if (!result.success) throw new CatalogFault("invalid_request");
      return service.createIntent(caller, result.data.idempotencyKey, result.data.publication);
    });
  }
  @Get("intents/:id")
  @CatalogPublisherRoute()
  @ApiOperation({ summary: "Read the current run's reserved upload keys and expiry" })
  @ApiZodResponse({ status: 200, schema: catalogIntentViewSchema })
  get(@Req() req: RequestWithPublisher, @Param("id") id: string) {
    return this.call(req, (service, caller) => service.getIntent(caller, id));
  }
  @Post("intents/:id/commit")
  @CatalogPublisherRoute()
  @ApiOperation({
    summary: "Verify exact uploaded versions and atomically register the whole release",
  })
  @ApiZodBody(publicationCommitRequestSchema)
  @ApiZodResponse({ status: 201, schema: catalogPublicationResultSchema })
  commit(@Req() req: RequestWithPublisher, @Param("id") id: string, @Body() input: unknown) {
    return this.call(req, (service, caller) => service.commitIntent(caller, id, input));
  }
  @Put("channels/:product/:channel")
  @CatalogPublisherRoute()
  @ApiOperation({
    summary: "Change a channel using its expected revision and an owned publication",
  })
  @ApiZodBody(channelChangeRequestSchema)
  @ApiZodResponse({ status: 200, schema: channelSnapshotSchema })
  change(
    @Req() req: RequestWithPublisher,
    @Param("product") product: string,
    @Param("channel") channel: string,
    @Body() input: unknown,
  ) {
    return this.call(req, (service, caller) =>
      service.changeChannel(caller, { product, channel }, input),
    );
  }
}
