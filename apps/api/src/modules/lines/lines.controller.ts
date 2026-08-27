import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodBody,
  ApiZodValidationError,
} from "../../lib/openapi";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  createLineSchema,
  lineOpenApiSchema,
  listLinePresenceOpenApiSchema,
  listLinesOpenApiSchema,
  updateLineSchema,
  type CreateLineDto,
  type LineDto,
  type ListLinesResponseDto,
  type ListLinePresenceResponseDto,
  type UpdateLineDto,
} from "./dto";
import { LinesService } from "./lines.service";

@ApiTags("lines")
@Controller("lines")
// The station never calls this module. Cabinet authorization keeps a station
// api-key out even though TenantGuard accepts it for tenant resolution.
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@ApiCabinetAuth()
export class LinesController {
  constructor(private readonly linesService: LinesService) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "List production lines" })
  @ApiOkResponse({ schema: listLinesOpenApiSchema })
  @ApiHttpErrors(401, 403)
  async listLines(@Req() req: RequestWithTenant): Promise<ListLinesResponseDto> {
    return this.linesService.listLines(req.tenantId!);
  }

  @Get("presence")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "List line station presence",
    description:
      "Per-line assigned and online station counts with the most recent station heartbeat.",
  })
  @ApiOkResponse({ schema: listLinePresenceOpenApiSchema })
  @ApiHttpErrors(401, 403)
  async listPresence(@Req() req: RequestWithTenant): Promise<ListLinePresenceResponseDto> {
    return this.linesService.listPresence(req.tenantId!);
  }

  @Get(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "Get a production line" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: lineOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  async getLine(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<LineDto> {
    return this.linesService.getLine(req.tenantId!, id);
  }

  @Post()
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({
    summary: "Create a production line",
    description: "Rejected (409) when the subscription's line quota is exhausted.",
  })
  @ApiZodBody(createLineSchema)
  @ApiCreatedResponse({ schema: lineOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 409)
  async createLine(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createLineSchema)) body: CreateLineDto,
  ): Promise<LineDto> {
    return this.linesService.createLine(req.tenantId!, body);
  }

  @Patch(":id")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Rename a production line" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(updateLineSchema)
  @ApiOkResponse({ schema: lineOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  async updateLine(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateLineSchema)) body: UpdateLineDto,
  ): Promise<LineDto> {
    return this.linesService.updateLine(req.tenantId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Delete a production line" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiResponse({ status: 204, description: "Line deleted." })
  @ApiHttpErrors(401, 403, 404, 409)
  async deleteLine(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.linesService.deleteLine(req.tenantId!, id);
  }
}
