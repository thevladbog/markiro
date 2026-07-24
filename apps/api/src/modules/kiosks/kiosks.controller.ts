import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  createKioskSchema,
  setKioskProductsSchema,
  updateKioskSchema,
  type CreateKioskDto,
  type EnrollKioskResponseDto,
  type KioskDto,
  type ListKiosksResponseDto,
  type SetKioskProductsDto,
  type UpdateKioskDto,
} from "./dto";
import { KiosksService } from "./kiosks.service";

@ApiTags("kiosks")
@Controller("kiosks")
@UseGuards(TenantGuard)
export class KiosksController {
  constructor(private readonly kiosksService: KiosksService) {}

  @Get()
  async listKiosks(@Req() req: RequestWithTenant): Promise<ListKiosksResponseDto> {
    return this.kiosksService.listKiosks(req.tenantId!);
  }

  @Post()
  async createKiosk(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createKioskSchema)) body: CreateKioskDto,
  ): Promise<KioskDto> {
    return this.kiosksService.createKiosk(req.tenantId!, body);
  }

  @Patch(":id")
  async updateKiosk(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateKioskSchema)) body: UpdateKioskDto,
  ): Promise<KioskDto> {
    return this.kiosksService.updateKiosk(req.tenantId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  async archiveKiosk(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.kiosksService.archiveKiosk(req.tenantId!, id);
  }

  @Put(":id/products")
  @HttpCode(200)
  async setProducts(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(setKioskProductsSchema)) body: SetKioskProductsDto,
  ): Promise<KioskDto> {
    return this.kiosksService.setProducts(req.tenantId!, id, body);
  }

  @Post(":id/enroll")
  @HttpCode(200)
  async enroll(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<EnrollKioskResponseDto> {
    return this.kiosksService.enroll(req.tenantId!, id);
  }
}
