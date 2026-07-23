import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { loadEnv } from "../../env";
import {
  createStationDeviceSchema,
  type CreateStationDeviceDto,
  type EnrollStationDeviceResponseDto,
  type ListStationDevicesResponseDto,
} from "./dto";
import { StationDevicesService } from "./station-devices.service";

@ApiTags("station-devices")
@Controller("station-devices")
@UseGuards(TenantGuard)
export class StationDevicesController {
  constructor(private readonly service: StationDevicesService) {}

  @Get()
  async list(@Req() req: RequestWithTenant): Promise<ListStationDevicesResponseDto> {
    return this.service.list(req.tenantId!);
  }

  @Post()
  async enroll(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createStationDeviceSchema)) body: CreateStationDeviceDto,
  ): Promise<EnrollStationDeviceResponseDto> {
    // The station will call back at this same origin; BETTER_AUTH_URL is the
    // canonical public API base handed to the device to persist as serverUrl.
    // req.userId (the enrolling member) owns the minted org-scoped key.
    return this.service.enroll(req.tenantId!, req.userId!, body.name, loadEnv().BETTER_AUTH_URL);
  }

  @Delete(":id")
  @HttpCode(204)
  async revoke(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.service.revoke(req.tenantId!, id);
  }
}
