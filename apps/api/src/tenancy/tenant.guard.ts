import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { fromNodeHeaders } from "better-auth/node";
import { and, eq, isNull } from "drizzle-orm";
import type { Request } from "express";
import { schema, type Auth, type Db } from "@markiro/db";
import { AUTH, DB } from "../auth/auth.module";
import type { CabinetPrincipal } from "../authorization/authorization.service";

export const STATION_CREDENTIAL_REVOKED_CODE = "STATION_CREDENTIAL_REVOKED";

function stationCredentialRevoked(): UnauthorizedException {
  return new UnauthorizedException({
    message: "Station credential revoked",
    code: STATION_CREDENTIAL_REVOKED_CODE,
  });
}

function hashStationApiKey(apiKey: string): string {
  // Better Auth's api-key plugin stores SHA-256 as unpadded base64url.
  // Keeping the lookup here direct is intentional: verifyApiKey catches
  // infrastructure exceptions and reports them as INVALID_API_KEY, which is
  // indistinguishable from revocation to an offline-first Station client.
  return createHash("sha256").update(apiKey).digest("base64url");
}

/** Exported so guarded controllers can type `@Req()` without re-declaring this. */
export interface RequestWithTenant extends Request {
  tenantId?: string;
  userId?: string;
  authKind?: "session" | "station";
  cabinetPrincipal?: CabinetPrincipal;
  /**
   * The calling station device's own id (`station_devices.id`), set only on
   * the api-key path below. A session-authenticated caller (admin/manager
   * UI) is not a device, so this stays undefined there. Consumers that need
   * a real device row (e.g. sscc block allocation, Task 7 -- `sscc_blocks
   * .device_id` carries a NOT NULL composite FK) must treat an undefined
   * `deviceId` as "no device to allocate for", not invent one.
   */
  deviceId?: string;
  /** Assigned production line for a station principal; null means no default line. */
  deviceLineId?: string | null;
}

/**
 * Resolves the caller's tenant from either a Better Auth session (admin/manager
 * UI) or a desktop Tauri Station's org-owned `x-api-key`, and requires an
 * active organization: no session and no valid api-key -> 401, session
 * without an active org -> 403. On success, attaches `req.tenantId` for
 * downstream handlers/repositories, and (on the session path) `req.userId`
 * (the Better Auth user id) for handlers that need to record who performed
 * an action (e.g. pickup order resolve).
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DB) private readonly db: Db,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithTenant>();

    // Primary path: an admin/manager Better Auth session with an active org.
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (session) {
      const tenantId = session.session.activeOrganizationId;
      if (!tenantId) throw new ForbiddenException("No active organization");
      req.tenantId = tenantId;
      req.authKind = "session";
      // Enrollment (Task 6) mints an org-owned key server-side and needs the
      // acting member's id as the key's `userId`; expose it on the request.
      req.userId = session.user.id;
      return true;
    }

    // Station path: no session, but a device-enrolled api-key. The key's
    // referenceId carries the tenantId (set at enrollment, Task 6).
    const apiKey = req.headers["x-api-key"];
    if (typeof apiKey === "string" && apiKey.length > 0) {
      const [key] = await this.db
        .select({
          id: schema.apikey.id,
          referenceId: schema.apikey.referenceId,
          enabled: schema.apikey.enabled,
          expiresAt: schema.apikey.expiresAt,
        })
        .from(schema.apikey)
        .where(
          and(
            eq(schema.apikey.key, hashStationApiKey(apiKey)),
            eq(schema.apikey.configId, "station"),
          ),
        );
      if (!key || key.enabled === false || (key.expiresAt?.getTime() ?? Infinity) <= Date.now()) {
        throw stationCredentialRevoked();
      }

      req.tenantId = key.referenceId;
      req.authKind = "station";
      // Enrollment (station-devices.service.ts) mints exactly one api-key
      // per device and stores that key's id as station_devices.apiKeyId --
      // a 1:1 mapping, so this lookup is the one reliable way to learn
      // which physical device is calling. Tenant-scoped in the statement
      // itself, matching every other query in this codebase.
      const [device] = await this.db
        .select({ id: schema.stationDevices.id, lineId: schema.stationDevices.lineId })
        .from(schema.stationDevices)
        .where(
          and(
            eq(schema.stationDevices.tenantId, req.tenantId),
            eq(schema.stationDevices.apiKeyId, key.id),
            isNull(schema.stationDevices.revokedAt),
          ),
        );
      // A live Better Auth key is not a station principal by itself. The
      // durable row is the authoritative device identity: reject an
      // unlinked/orphaned key so a failed pairing compensation cannot turn
      // into access to station-only endpoints.
      if (!device) throw stationCredentialRevoked();
      req.deviceId = device.id;
      req.deviceLineId = device.lineId;
      await this.db
        .update(schema.stationDevices)
        .set({ lastSeenAt: new Date() })
        .where(
          and(
            eq(schema.stationDevices.tenantId, req.tenantId),
            eq(schema.stationDevices.id, device.id),
            isNull(schema.stationDevices.revokedAt),
          ),
        );
      return true;
    }

    throw new UnauthorizedException();
  }
}
