import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  exportPickupCodesSchema,
  listPickupOrdersQuerySchema,
  resolvePickupOrderSchema,
  type ExportPickupCodesDto,
  type ListPickupOrdersQueryDto,
  type ListPickupOrdersResponseDto,
  type PickupOrderDetailDto,
  type PickupOrderRowDto,
  type ResolvePickupOrderDto,
} from "./dto";
import { PickupOrdersService } from "./pickup-orders.service";

/** Admin/office routes under `/pickup-orders`, authenticated via the Better Auth session cookie. */
@ApiTags("pickup-orders")
@Controller("pickup-orders")
@UseGuards(TenantGuard)
export class PickupOrdersController {
  constructor(private readonly pickupOrdersService: PickupOrdersService) {}

  @Get()
  async list(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listPickupOrdersQuerySchema)) query: ListPickupOrdersQueryDto,
  ): Promise<ListPickupOrdersResponseDto> {
    return this.pickupOrdersService.list(req.tenantId!, query);
  }

  @Get(":id")
  async detail(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<PickupOrderDetailDto> {
    return this.pickupOrdersService.detail(req.tenantId!, id);
  }

  @Post(":id/resolve")
  async resolve(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(resolvePickupOrderSchema)) body: ResolvePickupOrderDto,
  ): Promise<PickupOrderRowDto> {
    return this.pickupOrdersService.resolve(req.tenantId!, id, body, req.userId!);
  }

  @Post(":id/cancel")
  async cancel(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<PickupOrderRowDto> {
    return this.pickupOrdersService.cancel(req.tenantId!, id);
  }

  @Post("export")
  @HttpCode(200)
  async export(
    @Req() req: RequestWithTenant,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(exportPickupCodesSchema)) body: ExportPickupCodesDto,
  ): Promise<string> {
    const txt = await this.pickupOrdersService.exportCodes(req.tenantId!, body.orderIds);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="codes-${stamp}.txt"`);
    return txt;
  }
}
