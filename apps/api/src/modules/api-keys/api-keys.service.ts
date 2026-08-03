import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { schema, type Auth, type Db } from "@markiro/db";
import { and, desc, eq } from "drizzle-orm";
import { AUTH, DB } from "../../auth/auth.module";
import { JournalService } from "../integrations/journal.service";

/** Selects the `public` apiKey plugin configuration (see `packages/db/src/auth-config.ts`). */
const PUBLIC_API_CONFIG_ID = "public";
/** Tags a row's `metadata` so it can be told apart from every other kind sharing the `apikey` table. */
const PUBLIC_KEY_KIND = "public";

export interface ApiKeySummaryDto {
  id: string;
  name: string | null;
  kind: "public";
  createdAt: string;
  lastRequest: string | null;
}

/** Response of `create`: the plaintext `key` is handed back exactly once, here. */
export interface ApiKeyIssuedDto {
  id: string;
  key: string;
}

@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly journal: JournalService,
  ) {}

  /**
   * Public API keys share the `apikey` table with every other Better Auth
   * api-key kind (station devices, Task 6). `configId: "public"` already
   * separates them at the plugin-configuration level, but that alone is one
   * string away from a station key showing up here by mistake -- belt and
   * braces, this also requires `metadata.kind === "public"` (set by
   * `create` below) before a row is ever handed back as an "integration"
   * key. Skipping this second check would risk a station device, enrolled
   * under the same organization, showing up in this list; an admin who then
   * revokes it thinking it's an unused integration key would silently kill
   * a live station instead (see task-11-brief.md).
   */
  async list(tenantId: string): Promise<{ keys: ApiKeySummaryDto[] }> {
    const rows = await this.db
      .select()
      .from(schema.apikey)
      .where(
        and(
          eq(schema.apikey.referenceId, tenantId),
          eq(schema.apikey.configId, PUBLIC_API_CONFIG_ID),
        ),
      )
      .orderBy(desc(schema.apikey.createdAt));

    const keys = rows
      .filter((row) => parseMetadata(row.metadata).kind === PUBLIC_KEY_KIND)
      .map((row): ApiKeySummaryDto => ({
        id: row.id,
        name: row.name,
        kind: "public",
        createdAt: row.createdAt.toISOString(),
        lastRequest: row.lastRequest?.toISOString() ?? null,
      }));

    return { keys };
  }

  /**
   * Mints a fresh Better Auth api-key under the `public` plugin config
   * (`packages/db/src/auth-config.ts`), tagged `metadata: { kind: "public" }`
   * (see `list` above for why). The plaintext key is returned exactly once --
   * callers must persist it now; `list` never carries it. Mirrors
   * `StationDevicesService.enroll`/`IntegrationsService.issueCredentials`.
   *
   * `userId` is required by the plugin's `references: "organization"` path
   * (it checks that user is a member of `organizationId` with permission to
   * manage api-keys) -- the caller passes `req.userId`, set by `TenantGuard`
   * on its session branch, which `AuthorizationGuard` on this controller
   * requires before resolving cabinet permissions.
   */
  async create(tenantId: string, userId: string, name: string): Promise<ApiKeyIssuedDto> {
    const created = await this.auth.api.createApiKey({
      body: {
        configId: PUBLIC_API_CONFIG_ID,
        organizationId: tenantId,
        userId,
        name,
        metadata: { kind: PUBLIC_KEY_KIND },
      },
    });

    await this.journal.append({
      tenantId,
      channelType: "public_api",
      sessionId: null,
      direction: "local",
      outcome: "ok",
      grain: "session",
      message: `Выпущен ключ публичного API «${name}»`,
    });

    return { id: created.id, key: created.key };
  }

  /**
   * Revokes (deletes) a public api-key. This deletes the `apikey` row
   * directly rather than calling Better Auth's own `deleteApiKey` endpoint:
   * that endpoint requires an actual session-middleware context (`use:
   * [sessionMiddleware]` on `POST /api-key/delete` in `@better-auth/api-key`),
   * which this service call has no ready way to forward. Deleting the row
   * directly mirrors `StationDevicesService.revoke`, which does the same for
   * the same reason -- tenant ownership and kind are checked here instead,
   * the same way `list` above scopes rows.
   *
   * Revocation is meant to be irreversible (Task 15 enforces this in the
   * UI), but the server still needs a predictable answer to a REPEATED
   * revoke of the same id: once deleted, the row is gone, so a second call
   * finds nothing to revoke and gets exactly the same 404 as any other
   * unknown id -- there is no separate "already revoked" response. That
   * keeps this endpoint's contract identical to
   * `StationDevicesService.revoke`'s (a delete is either "found and gone
   * now" or "not found"), rather than inventing a second way to say "this
   * key isn't live" alongside the 404 that already covers it.
   *
   * The SELECT above and the DELETE below are two separate statements, not
   * one transaction, so two concurrent revokes of the same id can both pass
   * the SELECT before either commits its DELETE. That's harmless for the
   * row itself (only one DELETE actually removes it), but it must not
   * double-write the journal. `.returning()` on the DELETE is the gate:
   * Postgres still serializes the two DELETEs against each other, so only
   * the one that actually removes the row gets it back; the other matches
   * zero rows (the row is already gone by the time it runs) and returns
   * nothing. Journal only on an actual delete, so a race writes "ключ
   * отозван" exactly once per key, no matter how many concurrent requests
   * raced for it.
   */
  async revoke(tenantId: string, id: string): Promise<void> {
    const [row] = await this.db
      .select()
      .from(schema.apikey)
      .where(
        and(
          eq(schema.apikey.id, id),
          eq(schema.apikey.referenceId, tenantId),
          eq(schema.apikey.configId, PUBLIC_API_CONFIG_ID),
        ),
      );
    if (!row || parseMetadata(row.metadata).kind !== PUBLIC_KEY_KIND) {
      throw new NotFoundException("Unknown public API key");
    }

    const [deleted] = await this.db
      .delete(schema.apikey)
      .where(eq(schema.apikey.id, id))
      .returning();
    if (!deleted) return;

    await this.journal.append({
      tenantId,
      channelType: "public_api",
      sessionId: null,
      direction: "local",
      outcome: "ok",
      grain: "session",
      message: `Ключ публичного API «${row.name ?? row.id}» отозван`,
    });
  }
}

/**
 * `apikey.metadata` (`packages/db/src/schema/auth.ts`) is a raw `text`
 * column -- the plugin serializes/parses it internally when going through
 * its own adapter, but a direct `db.select()` like `list`/`revoke` above
 * gets the raw JSON string back, never an object. Never trust it
 * structurally: it's read here, not written by this code path other than
 * via `auth.api.createApiKey`.
 */
function parseMetadata(raw: string | null): { kind?: string } {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
