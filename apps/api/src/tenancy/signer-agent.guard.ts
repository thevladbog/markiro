import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Request } from "express";
import { schema, type Db } from "@markiro/db";
import { DB } from "../auth/auth.module";
import { hashDeviceToken } from "../pickup/device-token";

/** Exported so signer-agent-facing controllers can type `@Req()` without re-declaring this. */
export interface RequestWithSignerAgent extends Request {
  tenantId?: string;
  signerAgentId?: string;
}

/**
 * Authenticates a Chestny ZNAK signer agent via its `x-signer-token` header:
 * hashes the token, looks up an ACTIVE agent by `secret_hash`, and attaches
 * `req.tenantId`/`req.signerAgentId` for downstream handlers. Also bumps
 * `last_seen_at`, same shape as `KioskDeviceGuard`. Missing header or no
 * matching active agent -> 401.
 */
@Injectable()
export class SignerAgentGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithSignerAgent>();
    const header = req.headers["x-signer-token"];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token) throw new UnauthorizedException();

    const [agent] = await this.db
      .select({
        id: schema.chzSignerAgents.id,
        tenantId: schema.chzSignerAgents.tenantId,
      })
      .from(schema.chzSignerAgents)
      .where(
        and(
          eq(schema.chzSignerAgents.secretHash, hashDeviceToken(token)),
          eq(schema.chzSignerAgents.status, "active"),
        ),
      );
    if (!agent) throw new UnauthorizedException();

    req.tenantId = agent.tenantId;
    req.signerAgentId = agent.id;
    await this.db
      .update(schema.chzSignerAgents)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.chzSignerAgents.id, agent.id));
    return true;
  }
}
