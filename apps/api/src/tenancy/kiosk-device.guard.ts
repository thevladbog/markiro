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

/** Exported so kiosk-facing controllers can type `@Req()` without re-declaring this. */
export interface RequestWithKiosk extends Request {
  tenantId?: string;
  kioskId?: string;
}

/**
 * Authenticates a kiosk device via its `x-kiosk-token` header: hashes the
 * token, looks up an ACTIVE kiosk by `device_token_hash`, and attaches
 * `req.tenantId`/`req.kioskId` for downstream handlers. Also bumps
 * `last_seen_at` so operators can see which kiosks are actually checking in.
 * Missing header or no matching active kiosk -> 401.
 */
@Injectable()
export class KioskDeviceGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithKiosk>();
    const header = req.headers["x-kiosk-token"];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token) throw new UnauthorizedException();

    const [kiosk] = await this.db
      .select()
      .from(schema.kiosks)
      .where(
        and(
          eq(schema.kiosks.deviceTokenHash, hashDeviceToken(token)),
          eq(schema.kiosks.status, "active"),
        ),
      );
    if (!kiosk) throw new UnauthorizedException();

    req.tenantId = kiosk.tenantId;
    req.kioskId = kiosk.id;
    await this.db
      .update(schema.kiosks)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.kiosks.id, kiosk.id));
    return true;
  }
}
