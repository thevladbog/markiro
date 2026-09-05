import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import {
  ApiCookieAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  type SchemaObject,
} from "@nestjs/swagger";
import {
  createUsLocationSchema,
  createUsPartySchema,
  listUsLocationsQuerySchema,
  listUsPartiesQuerySchema,
  updateUsLocationSchema,
  updateUsPartySchema,
  usLocationListSchema,
  usLocationSchema,
  usPartyListSchema,
  usPartySchema,
  usTraceabilityAccessSchema,
} from "@markiro/platform-contracts";
import { ApiZodBody, ApiZodQuery, ApiZodResponse, httpErrorSchema } from "../lib/openapi";
import { UsRuntime } from "./us-runtime";
import { UsSessionGuard, type UsRequest } from "./us-profile.controller";

const errorSchema: SchemaObject = {
  oneOf: [
    httpErrorSchema,
    { type: "object", required: ["code"], properties: { code: { type: "string" } } },
  ],
};

const masterDataValidationErrorSchema: SchemaObject = {
  type: "object",
  required: ["code", "issues"],
  additionalProperties: false,
  properties: {
    code: { type: "string", enum: ["invalid_master_data"] },
    issues: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "message"],
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          message: { type: "string" },
        },
      },
    },
  },
};

const badRequestSchema: SchemaObject = {
  oneOf: [
    httpErrorSchema,
    masterDataValidationErrorSchema,
    {
      type: "object",
      required: ["code"],
      additionalProperties: false,
      properties: { code: { type: "string", enum: ["us_invalid_body"] } },
    },
  ],
};

@Controller("traceability")
@UseGuards(UsSessionGuard)
@ApiTags("us-traceability-master-data")
@ApiCookieAuth("markiro-us.session_token")
@ApiResponse({
  status: 400,
  description: "Malformed JSON or strict request validation failed.",
  schema: badRequestSchema,
})
@ApiResponse({ status: 401, description: "A US session is required.", schema: errorSchema })
@ApiResponse({
  status: 403,
  description: "The current US role is not permitted.",
  schema: errorSchema,
})
@ApiResponse({
  status: 404,
  description: "The tenant-scoped resource was not found.",
  schema: errorSchema,
})
@ApiResponse({ status: 413, description: "JSON body exceeds 16 KiB.", schema: errorSchema })
@ApiResponse({
  status: 415,
  description: "An uncompressed application/json body is required.",
  schema: errorSchema,
})
@ApiResponse({
  status: 503,
  description: "The US profile or database is unavailable.",
  schema: errorSchema,
})
export class UsMasterDataController {
  constructor(@Inject(UsRuntime) private readonly runtime: UsRuntime) {}

  @Get("access")
  @ApiOperation({
    summary: "Read presentation capabilities for the active US membership",
    description:
      "Presentation metadata only. Every business request independently reloads and enforces authorization.",
  })
  @ApiZodResponse({ status: 200, schema: usTraceabilityAccessSchema })
  access(@Req() request: UsRequest) {
    return { capabilities: this.principal(request).capabilities };
  }

  @Get("parties")
  @ApiOperation({ summary: "List parties in the active US tenant" })
  @ApiZodQuery(listUsPartiesQuerySchema)
  @ApiZodResponse({ status: 200, schema: usPartyListSchema })
  listParties(@Req() request: UsRequest, @Query() query: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.masterData.listParties(principal.tenantId, principal.userId, query),
    );
  }

  @Post("parties")
  @ApiOperation({ summary: "Create a party in the active US tenant" })
  @ApiZodBody(createUsPartySchema)
  @ApiZodResponse({ status: 201, schema: usPartySchema })
  @ApiResponse({
    status: 409,
    description: "The requested active party name is taken.",
    schema: errorSchema,
  })
  createParty(@Req() request: UsRequest, @Body() body: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.masterData.createParty(
        principal.tenantId,
        principal.userId,
        body,
        this.requestId(request),
      ),
    );
  }

  @Get("parties/:id")
  @ApiOperation({ summary: "Read one tenant-scoped party" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodResponse({ status: 200, schema: usPartySchema })
  getParty(@Req() request: UsRequest, @Param("id") id: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.masterData.getParty(principal.tenantId, principal.userId, id),
    );
  }

  @Patch("parties/:id")
  @ApiOperation({ summary: "Update, archive or restore a tenant-scoped party" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(updateUsPartySchema)
  @ApiZodResponse({ status: 200, schema: usPartySchema })
  @ApiResponse({
    status: 409,
    description: "The requested active party name is taken.",
    schema: errorSchema,
  })
  updateParty(@Req() request: UsRequest, @Param("id") id: unknown, @Body() body: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.masterData.updateParty(
        principal.tenantId,
        principal.userId,
        id,
        body,
        this.requestId(request),
      ),
    );
  }

  @Get("locations")
  @ApiOperation({ summary: "List physical locations in the active US tenant" })
  @ApiZodQuery(listUsLocationsQuerySchema)
  @ApiZodResponse({ status: 200, schema: usLocationListSchema })
  listLocations(@Req() request: UsRequest, @Query() query: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.masterData.listLocations(principal.tenantId, principal.userId, query),
    );
  }

  @Post("locations")
  @ApiOperation({ summary: "Create a physical location in the active US tenant" })
  @ApiZodBody(createUsLocationSchema)
  @ApiZodResponse({ status: 201, schema: usLocationSchema })
  createLocation(@Req() request: UsRequest, @Body() body: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.masterData.createLocation(
        principal.tenantId,
        principal.userId,
        body,
        this.requestId(request),
      ),
    );
  }

  @Get("locations/:id")
  @ApiOperation({ summary: "Read one tenant-scoped physical location" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodResponse({ status: 200, schema: usLocationSchema })
  getLocation(@Req() request: UsRequest, @Param("id") id: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.masterData.getLocation(principal.tenantId, principal.userId, id),
    );
  }

  @Patch("locations/:id")
  @ApiOperation({ summary: "Update, archive or restore a tenant-scoped physical location" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(updateUsLocationSchema)
  @ApiZodResponse({ status: 200, schema: usLocationSchema })
  updateLocation(@Req() request: UsRequest, @Param("id") id: unknown, @Body() body: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.masterData.updateLocation(
        principal.tenantId,
        principal.userId,
        id,
        body,
        this.requestId(request),
      ),
    );
  }

  private principal(request: UsRequest) {
    if (!request.usPrincipal) throw new UnauthorizedException("us_session_required");
    return request.usPrincipal;
  }

  private requestId(request: UsRequest): string {
    if (!request.usRequestId) throw new UnauthorizedException("us_request_context_required");
    return request.usRequestId;
  }
}
