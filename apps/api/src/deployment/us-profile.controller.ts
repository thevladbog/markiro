import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import {
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  type SchemaObject,
} from "@nestjs/swagger";
import {
  provisionUsTraceabilityProfileSchema,
  usTraceabilityProfileSummarySchema as summarySchema,
} from "@markiro/platform-contracts";
import type { Request } from "express";
import { ApiZodBody, ApiZodResponse, httpErrorSchema } from "../lib/openapi";
import { resolveUsPrincipal, type UsPrincipal } from "../modules/traceability/auth/us-principal";
import { UsRuntime } from "./us-runtime";

const errorSchema: SchemaObject = {
  oneOf: [
    httpErrorSchema,
    { type: "object", required: ["code"], properties: { code: { type: "string" } } },
  ],
};

export interface UsRequest extends Request {
  usPrincipal?: UsPrincipal;
  usRequestId?: string;
}

@Injectable()
export class UsSessionGuard implements CanActivate {
  constructor(@Inject(UsRuntime) private readonly runtime: UsRuntime) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<UsRequest>();
    if (!request.headers.cookie) throw new UnauthorizedException("us_session_required");
    await this.runtime.assertDatabaseReady();
    request.usPrincipal = await this.runtime.databaseOperation(() =>
      resolveUsPrincipal(
        this.runtime.connection.db,
        this.runtime.auth,
        fromNodeHeaders(request.headers),
      ),
    );
    return true;
  }
}

@Controller("traceability/profile")
@UseGuards(UsSessionGuard)
@ApiTags("us-traceability-profile")
@ApiCookieAuth("markiro-us.session_token")
@ApiResponse({ status: 401, description: "A US session is required.", schema: errorSchema })
@ApiResponse({
  status: 403,
  description: "Trusted host/origin, verified MFA and an authorized US tenant role are required.",
  schema: errorSchema,
})
@ApiResponse({
  status: 503,
  description: "Profile is absent or incompatible, or the isolated database is unavailable.",
  schema: errorSchema,
})
export class UsProfileController {
  constructor(@Inject(UsRuntime) private readonly runtime: UsRuntime) {}

  @Get()
  @ApiOperation({
    summary: "Read the active US tenant's initial traceability profile",
    description:
      "Requires traceability.read. Only a settings administrator receives the initial-setup signal when the profile is absent; other readers receive 403.",
  })
  @ApiZodResponse({ status: 200, schema: summarySchema })
  read(@Req() request: UsRequest) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.profiles.read(principal.tenantId, principal.userId),
    );
  }

  @Put()
  @ApiOperation({
    summary: "Provision the active US tenant's initial traceability profile",
    description:
      "Requires tenant.settings.manage (US owner/admin). Initial provisioning only. Identical retries return the original profile without another audit event. Tenant, actor, request ID, baseline and timestamps are server-owned. Profile switching is not supported.",
  })
  @ApiZodBody(provisionUsTraceabilityProfileSchema)
  @ApiZodResponse({ status: 200, schema: summarySchema })
  @ApiResponse({
    status: 400,
    description: "Malformed JSON or invalid strict profile input.",
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: "A different profile configuration has already been provisioned.",
    schema: errorSchema,
  })
  @ApiResponse({ status: 413, description: "JSON body exceeds 16 KiB.", schema: errorSchema })
  @ApiResponse({
    status: 415,
    description: "An uncompressed application/json body is required.",
    schema: errorSchema,
  })
  provision(@Req() request: UsRequest, @Body() body: unknown) {
    const principal = this.principal(request);
    const requestId = request.usRequestId;
    if (!requestId) throw new UnauthorizedException("us_request_context_required");
    return this.runtime.databaseOperation(() =>
      this.runtime.profiles.provision(principal.tenantId, principal.userId, body, requestId),
    );
  }

  private principal(request: UsRequest): UsPrincipal {
    if (!request.usPrincipal) throw new UnauthorizedException("us_session_required");
    return request.usPrincipal;
  }
}
