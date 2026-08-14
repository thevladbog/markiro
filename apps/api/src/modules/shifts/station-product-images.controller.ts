import { Controller, Get, Param, Req, Res, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
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
export class StationProductImagesController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly storage: ObjectStorageService,
  ) {}

  @Get("products/:id/image/:checksum")
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
