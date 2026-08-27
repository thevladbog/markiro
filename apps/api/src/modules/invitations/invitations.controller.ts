import { Body, Controller, Get, Ip, Param, Post, Req, Res } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Request, Response as ExpressResponse } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { ApiHttpErrors, ApiZodBody, ApiZodValidationError } from "../../lib/openapi";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  invitationMembershipResponseOpenApiSchema,
  publicInvitationOpenApiSchema,
  registerInvitationResponseOpenApiSchema,
  registerInvitationSchema,
  type PublicInvitationDto,
  type RegisterInvitationDto,
} from "./dto";
import { InvitationsService } from "./invitations.service";
import { InvitationLookupRateLimiter } from "./invitation-lookup-rate-limiter";

@ApiTags("invitations")
@Controller("invitations")
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly lookupRateLimiter: InvitationLookupRateLimiter,
  ) {}

  @Get(":id")
  @ApiOperation({
    summary: "Get a pending invitation's public view",
    description:
      "Unauthenticated lookup by invitation id; the organization name is masked and the response reveals whether an account already exists for the invited email.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiResponse({ status: 200, schema: publicInvitationOpenApiSchema })
  @ApiHttpErrors(404, 429)
  getPublic(@Param("id") id: string, @Ip() source: string): Promise<PublicInvitationDto> {
    this.lookupRateLimiter.assertAllowed(source, id);
    return this.invitations.getPublic(id);
  }

  @Post(":id/register")
  @ApiOperation({
    summary: "Register an account via an invitation",
    description:
      "Creates an account for the invited email through Better Auth sign-up; a failed sign-up response is forwarded verbatim with its original status.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(registerInvitationSchema)
  @ApiResponse({ status: 201, schema: registerInvitationResponseOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(404, 409)
  async register(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(registerInvitationSchema)) body: RegisterInvitationDto,
    @Req() request: Request,
    @Res() response: ExpressResponse,
  ): Promise<void> {
    const authResponse = await this.invitations.register(
      id,
      body,
      fromNodeHeaders(request.headers),
    );
    await forwardAuthResponse(authResponse, response, 201);
  }

  @Post(":id/accept")
  @ApiOperation({
    summary: "Accept an invitation",
    description:
      "The signed-in account must match the invited email; the Better Auth acceptance response is forwarded verbatim.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiResponse({ status: 200, schema: invitationMembershipResponseOpenApiSchema })
  @ApiHttpErrors(401, 403, 404, 409)
  async accept(
    @Param("id") id: string,
    @Req() request: Request,
    @Res() response: ExpressResponse,
  ): Promise<void> {
    const authResponse = await this.invitations.accept(id, fromNodeHeaders(request.headers));
    await forwardAuthResponse(authResponse, response);
  }

  @Post(":id/reject")
  @ApiOperation({
    summary: "Reject an invitation",
    description: "The signed-in account must match the invited email.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiResponse({ status: 200, schema: invitationMembershipResponseOpenApiSchema })
  @ApiHttpErrors(401, 403, 404, 409)
  async reject(
    @Param("id") id: string,
    @Req() request: Request,
    @Res() response: ExpressResponse,
  ): Promise<void> {
    const authResponse = await this.invitations.reject(id, fromNodeHeaders(request.headers));
    await forwardAuthResponse(authResponse, response);
  }
}

async function forwardAuthResponse(
  source: Response,
  target: ExpressResponse,
  successStatus?: number,
): Promise<void> {
  for (const [name, value] of source.headers.entries()) {
    if (name !== "content-length" && name !== "set-cookie") target.setHeader(name, value);
  }
  const getSetCookie = source.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = getSetCookie.getSetCookie?.() ?? [];
  if (cookies.length) target.setHeader("set-cookie", cookies);
  const body = await source.text();
  target.status(source.ok && successStatus ? successStatus : source.status);
  target.send(body);
}
