import { createHash } from "node:crypto";
import {
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import type { PublicApiScope } from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import { DB } from "../../auth/auth.module";
import {
  parsePublicApiMetadata,
  type PublicApiPrincipal,
  type PublicApiTransaction,
} from "./public-api.types";

@Injectable()
export class PublicApiAuthService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async authenticate(rawKey: string): Promise<PublicApiPrincipal> {
    if (!rawKey || rawKey.length > 4096) throw new UnauthorizedException("Invalid public API key");
    try {
      // Better Auth defaultKeyHasher is SHA-256/base64url. Its verify endpoint
      // catches database failures as INVALID_API_KEY, so this boundary queries
      // directly and preserves infrastructure failures as 503.
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.apikey)
          .where(
            and(
              eq(schema.apikey.key, createHash("sha256").update(rawKey).digest("base64url")),
              eq(schema.apikey.configId, "public"),
            ),
          )
          .for("update");
        const principal = this.principal(row);
        if (!row) throw new UnauthorizedException("Invalid public API key");
        // Issuance persists configuration defaults (public: 60/minute). Preserve
        // per-key overrides and the plugin's disabled/null policy behavior.
        // The row lock serializes consumption; assertCurrent consumes nothing.
        const now = new Date();
        let requestCount = row.requestCount;
        let lastRequest = row.lastRequest;
        if (row.rateLimitEnabled === false) {
          lastRequest = now;
        } else {
          const { rateLimitMax, rateLimitTimeWindow } = row;
          if (
            (rateLimitMax !== null && (!Number.isSafeInteger(rateLimitMax) || rateLimitMax <= 0)) ||
            (rateLimitTimeWindow !== null &&
              (!Number.isSafeInteger(rateLimitTimeWindow) || rateLimitTimeWindow <= 0)) ||
            (requestCount !== null && (!Number.isSafeInteger(requestCount) || requestCount < 0))
          )
            throw new UnauthorizedException("Invalid public API rate policy");
          // Better Auth treats null max/window as an explicit skip and does not
          // update lastRequest or requestCount for that case.
          if (rateLimitMax !== null && rateLimitTimeWindow !== null) {
            const count =
              lastRequest && now.getTime() - lastRequest.getTime() <= rateLimitTimeWindow
                ? (requestCount ?? 0)
                : 0;
            if (count >= rateLimitMax)
              throw new HttpException("Public API rate limit exceeded", 429);
            requestCount = count + 1;
            lastRequest = now;
          }
        }
        let remaining = row.remaining;
        let lastRefillAt = row.lastRefillAt;
        if (remaining !== null) {
          if (
            row.refillInterval &&
            row.refillAmount &&
            now.getTime() - (lastRefillAt ?? row.createdAt).getTime() > row.refillInterval
          ) {
            remaining = row.refillAmount;
            lastRefillAt = now;
          }
          if (remaining <= 0) throw new HttpException("Public API usage limit exceeded", 429);
          remaining -= 1;
        }
        await tx
          .update(schema.apikey)
          .set({
            requestCount,
            lastRequest,
            remaining,
            lastRefillAt,
            updatedAt: now,
          })
          .where(eq(schema.apikey.id, row.id));
        return principal;
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException("Public API authentication unavailable");
    }
  }

  async assertCurrent(
    tx: PublicApiTransaction,
    principal: PublicApiPrincipal,
    requiredScope: PublicApiScope,
  ): Promise<void> {
    try {
      const [row] = await tx
        .select()
        .from(schema.apikey)
        .where(
          and(
            eq(schema.apikey.id, principal.keyId),
            eq(schema.apikey.referenceId, principal.tenantId),
            eq(schema.apikey.configId, "public"),
          ),
        )
        .for("update");
      const current = this.principal(row);
      if (principal.kind !== "public_api" || !current.scopes.includes(requiredScope)) {
        throw new ForbiddenException("Public API scope required");
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException("Public API authentication unavailable");
    }
  }

  private principal(row: typeof schema.apikey.$inferSelect | undefined): PublicApiPrincipal {
    const metadata = parsePublicApiMetadata(row?.metadata ?? null);
    if (
      !row ||
      row.configId !== "public" ||
      row.enabled !== true ||
      !row.referenceId ||
      !metadata ||
      (row.expiresAt?.getTime() ?? Infinity) <= Date.now()
    ) {
      throw new UnauthorizedException("Invalid public API key");
    }
    return {
      kind: "public_api",
      tenantId: row.referenceId,
      keyId: row.id,
      scopes: metadata.scopes,
    };
  }
}
