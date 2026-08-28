import { Controller, Get, Param, Req, Res, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { ApiHttpErrors, ApiStationAuth } from "../../lib/openapi";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ObjectStorageService } from "../storage/object-storage.service";
import { sendPrivateImage } from "../storage/private-image-response";
import { ProductsService } from "../products/products.service";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { AllowSubscriptionReadOnly } from "../../subscriptions/subscription-access-policy";

@ApiTags("station")
@Controller("station")
@UseGuards(TenantGuard, StationOnlyGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@ApiStationAuth()
export class StationProductImagesController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly storage: ObjectStorageService,
  ) {}

  @Get("products/:id/image/:checksum")
  @ApiOperation({
    summary: "Read a product image",
    description:
      "Streams the content-addressed WebP through the API origin so device CSPs restricted to `self` can render it.",
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiParam({ name: "checksum", description: "Content checksum of the current product image." })
  @ApiResponse({
    status: 200,
    description: "The product image bytes.",
    content: { "image/webp": { schema: { type: "string", format: "binary" } } },
  })
  @ApiHttpErrors(401, 403, 404, 429)
  async readProductImage(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Param("checksum") checksum: string,
    @Res() response: Response,
  ): Promise<void> {
    const objectKey = await this.productsService.getCurrentImageRead(req.tenantId!, id, checksum);
    await sendPrivateImage(this.storage, objectKey, checksum, response);
  }
}
