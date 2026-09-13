import { Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags, ApiParam } from "@nestjs/swagger";
import { publicProductSchema, publicProductsSchema } from "@markiro/platform-contracts";
import { ApiHttpErrors, ApiZodQuery, ApiZodResponse } from "../../lib/openapi";
import { ZodValidationPipe } from "../../zod.pipe";
import { inventoryIdSchema } from "../inventories/dto";
import { PublicApiGuard, RequirePublicApiScope } from "./public-api.guard";
import {
  ApiPublicAuth,
  publicPrincipal,
  publicProductsQuerySchema,
  type PublicProductsQuery,
} from "./public-api.dto";
import { PublicApiReadService } from "./public-api-read.service";
import type { RequestWithPublicApiPrincipal } from "./public-api.types";
@ApiTags("public-v1")
@ApiPublicAuth()
@Controller("public/v1/products")
@UseGuards(PublicApiGuard)
export class PublicProductsController {
  constructor(private readonly reads: PublicApiReadService) {}
  @Get()
  @RequirePublicApiScope("catalog.products.read")
  @ApiOperation({ summary: "List unarchived tenant products" })
  @ApiZodQuery(publicProductsQuerySchema)
  @ApiZodResponse({ status: 200, schema: publicProductsSchema })
  @ApiHttpErrors(400, 401, 403, 429, 503)
  list(
    @Req() req: RequestWithPublicApiPrincipal,
    @Query(new ZodValidationPipe(publicProductsQuerySchema)) query: PublicProductsQuery,
  ) {
    return this.reads.products(publicPrincipal(req), query);
  }
  @Get(":id")
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @RequirePublicApiScope("catalog.products.read")
  @ApiOperation({ summary: "Get an unarchived tenant product" })
  @ApiZodResponse({ status: 200, schema: publicProductSchema })
  @ApiHttpErrors(400, 401, 403, 404, 429, 503)
  get(
    @Req() req: RequestWithPublicApiPrincipal,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
  ) {
    return this.reads.product(publicPrincipal(req), id);
  }
}
