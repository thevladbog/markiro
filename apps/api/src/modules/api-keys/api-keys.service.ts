import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { schema, type Auth, type Db } from "@markiro/db";
import { and, desc, eq } from "drizzle-orm";
import { publicApiScopesSchema, type PublicApiScope } from "@markiro/platform-contracts";
import { parsePublicApiMetadata } from "../public-api/public-api.types";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
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
  scopes: PublicApiScope[];
  createdAt: string;
  lastRequest: string | null;
}

/** Response of `create`: the plaintext `key` is handed back exactly once, here. */
export interface ApiKeyIssuedDto {
  id: string;
  key: string;
  scopes: PublicApiScope[];
}

@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly journal: JournalService,
    private readonly entitlements: EntitlementsService,
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
        scopes: parsePublicApiMetadata(row.metadata)?.scopes ?? [],
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
  async create(
    tenantId: string,
    userId: string,
    name: string,
    scopes: PublicApiScope[] = [],
  ): Promise<ApiKeyIssuedDto> {
    const created = await this.auth.api.createApiKey({
      body: {
        configId: PUBLIC_API_CONFIG_ID,
        organizationId: tenantId,
        userId,
        name,
        metadata: { kind: PUBLIC_KEY_KIND, scopes: publicApiScopesSchema.parse(scopes) },
      },
    });

    try {
      await this.db.transaction(async (tx) => {
        const [owned] = await tx
          .select({ id: schema.apikey.id })
          .from(schema.apikey)
          .where(
            and(
              eq(schema.apikey.id, created.id),
              eq(schema.apikey.referenceId, tenantId),
              eq(schema.apikey.configId, PUBLIC_API_CONFIG_ID),
            ),
          )
          .for("update");
        if (!owned) throw new NotFoundException("Issued public key no longer exists");
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: tenantId,
          actorUserId: userId,
          action: "public_api_key.created",
          outcome: "success",
          targetType: "public_api_key",
          targetId: created.id,
          after: { keyId: created.id, scopes },
        });
        await this.journal.append(
          {
            tenantId,
            channelType: "public_api",
            sessionId: null,
            direction: "local",
            outcome: "ok",
            grain: "session",
            message: `Выпущен ключ публичного API «${name}»`,
            details: {
              action: "public_api_key.created",
              keyId: created.id,
              issuerUserId: userId,
              scopes,
            },
          },
          tx,
        );
      });
    } catch (error) {
      // Better Auth minted on its own boundary. Reconcile an ambiguous COMMIT
      // before deciding whether this still-unrevealed credential needs retiring.
      let recorded: boolean;
      try {
        recorded = await this.db.transaction(async (tx) => {
          // An unlocked absence read can precede the original COMMIT. Wait for
          // its exact key-row lock before reading the audit or retiring the key.
          await tx
            .select({ id: schema.apikey.id })
            .from(schema.apikey)
            .where(
              and(
                eq(schema.apikey.id, created.id),
                eq(schema.apikey.referenceId, tenantId),
                eq(schema.apikey.configId, PUBLIC_API_CONFIG_ID),
              ),
            )
            .for("update");
          const [audit] = await tx
            .select({ id: schema.tenantAuditEvents.id })
            .from(schema.tenantAuditEvents)
            .where(
              and(
                eq(schema.tenantAuditEvents.organizationId, tenantId),
                eq(schema.tenantAuditEvents.actorUserId, userId),
                eq(schema.tenantAuditEvents.targetType, "public_api_key"),
                eq(schema.tenantAuditEvents.targetId, created.id),
                eq(schema.tenantAuditEvents.action, "public_api_key.created"),
                eq(schema.tenantAuditEvents.outcome, "success"),
              ),
            );
          if (audit) return true;
          await tx
            .delete(schema.apikey)
            .where(
              and(
                eq(schema.apikey.id, created.id),
                eq(schema.apikey.referenceId, tenantId),
                eq(schema.apikey.configId, PUBLIC_API_CONFIG_ID),
              ),
            );
          return false;
        });
      } catch {
        throw new ServiceUnavailableException(
          "Public API key issuance uncertain; inspect existing keys before retrying",
        );
      }
      if (!recorded) throw error;
    }

    return { id: created.id, key: created.key, scopes };
  }

  /** Scope edits and revoke acquire the same key-row lock as owner revalidation. */
  async updateScopes(
    tenantId: string,
    userId: string,
    id: string,
    scopes: PublicApiScope[],
  ): Promise<{ id: string; scopes: PublicApiScope[] }> {
    const afterScopes = publicApiScopesSchema.parse(scopes);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.apikey)
        .where(
          and(
            eq(schema.apikey.id, id),
            eq(schema.apikey.referenceId, tenantId),
            eq(schema.apikey.configId, PUBLIC_API_CONFIG_ID),
          ),
        )
        .for("update");
      const metadata = parsePublicApiMetadata(row?.metadata ?? null);
      if (!row || !metadata) throw new NotFoundException("Unknown public API key");
      const beforeScopes = metadata.scopes;
      if (afterScopes.some((scope) => !beforeScopes.includes(scope))) {
        await this.entitlements.assertFeatureAccess(tenantId, "publicApi", tx);
      }
      await tx
        .update(schema.apikey)
        .set({
          metadata: JSON.stringify({ kind: PUBLIC_KEY_KIND, scopes: afterScopes }),
          updatedAt: new Date(),
        })
        .where(eq(schema.apikey.id, id));
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId: userId,
        action: "public_api_key.scopes.update",
        outcome: "success",
        targetType: "public_api_key",
        targetId: id,
        before: { scopes: beforeScopes },
        after: { scopes: afterScopes },
      });
      await this.journal.append(
        {
          tenantId,
          channelType: "public_api",
          sessionId: null,
          direction: "local",
          outcome: "ok",
          grain: "session",
          message: "Изменены права ключа публичного API",
          details: {
            action: "public_api_key.scopes.update",
            tenantId,
            userId,
            keyId: id,
            outcome: "succeeded",
            beforeScopes,
            afterScopes,
          },
        },
        tx,
      );
      return { id, scopes: afterScopes };
    });
  }

  async revoke(tenantId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.apikey)
        .where(
          and(
            eq(schema.apikey.id, id),
            eq(schema.apikey.referenceId, tenantId),
            eq(schema.apikey.configId, PUBLIC_API_CONFIG_ID),
          ),
        )
        .for("update");
      // A malformed scope payload must still be revocable by its tenant owner.
      if (!row || parseMetadata(row.metadata).kind !== PUBLIC_KEY_KIND)
        throw new NotFoundException("Unknown public API key");
      await tx.delete(schema.apikey).where(eq(schema.apikey.id, id));
      await this.journal.append(
        {
          tenantId,
          channelType: "public_api",
          sessionId: null,
          direction: "local",
          outcome: "ok",
          grain: "session",
          message: `Ключ публичного API «${row.name ?? row.id}» отозван`,
        },
        tx,
      );
    });
  }
}

function parseMetadata(raw: string | null): { kind?: string } {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
