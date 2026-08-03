import { Body, Controller, Get, Ip, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response as ExpressResponse } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  registerInvitationSchema,
  type PublicInvitationDto,
  type RegisterInvitationDto,
} from "./dto";
import { InvitationsService } from "./invitations.service";
import { InvitationLookupRateLimiter } from "./invitation-lookup-rate-limiter";

@Controller("invitations")
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly lookupRateLimiter: InvitationLookupRateLimiter,
  ) {}

  @Get(":id")
  getPublic(@Param("id") id: string, @Ip() source: string): Promise<PublicInvitationDto> {
    this.lookupRateLimiter.assertAllowed(source, id);
    return this.invitations.getPublic(id);
  }

  @Post(":id/register")
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
  async accept(
    @Param("id") id: string,
    @Req() request: Request,
    @Res() response: ExpressResponse,
  ): Promise<void> {
    const authResponse = await this.invitations.accept(id, fromNodeHeaders(request.headers));
    await forwardAuthResponse(authResponse, response);
  }

  @Post(":id/reject")
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
