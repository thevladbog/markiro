import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import {
  AllowStationOrPermissions,
  RequirePermissions,
} from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  createProductSchema,
  gtinCheckSchema,
  listProductsQuerySchema,
  updateProductSchema,
  type CreateProductDto,
  type GtinCheckDto,
  type GtinCheckResponseDto,
  type ListProductsQueryDto,
  type ListProductsResponseDto,
  type ProductDto,
  type UpdateProductDto,
} from "./dto";
import { ProductsService } from "./products.service";

@ApiTags("products")
@Controller("products")
@UseGuards(TenantGuard, AuthorizationGuard)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async listProducts(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listProductsQuerySchema)) query: ListProductsQueryDto,
  ): Promise<ListProductsResponseDto> {
    return this.productsService.listProducts(req.tenantId!, query);
  }

  @Post("gtin-check")
  @HttpCode(HttpStatus.OK)
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async checkGtinOwner(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(gtinCheckSchema)) body: GtinCheckDto,
  ): Promise<GtinCheckResponseDto> {
    return this.productsService.checkGtinOwner(req.tenantId!, body.gtin);
  }

  // Cabinet-only: not one of the station's two routes (list, gtin-check)
  // above. The station resolves a scanned GTIN via search on the list
  // endpoint, so it never needs get-by-id or any of the catalog mutations.
  @Get(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async getProduct(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<ProductDto> {
    return this.productsService.getProduct(req.tenantId!, id);
  }

  @Post()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async createProduct(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductDto,
  ): Promise<ProductDto> {
    return this.productsService.createProduct(req.tenantId!, body);
  }

  @Patch(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async updateProduct(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductDto,
  ): Promise<ProductDto> {
    return this.productsService.updateProduct(req.tenantId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async deleteProduct(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.productsService.deleteProduct(req.tenantId!, id);
  }
}
