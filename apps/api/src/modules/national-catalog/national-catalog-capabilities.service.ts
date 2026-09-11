import { schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import {
  catalogCapabilitiesSchema,
  type CatalogCapabilities,
  type EntitlementSnapshotV1,
} from "@markiro/platform-contracts";
import type { Env } from "../../env";
import { chzSignerSettingsSchema } from "../integrations/channel-registry";
import { CHZ_TRUE_API_BASE_URLS } from "../signer-agents/chz-constants";
import type { ChzTokenService } from "../chz-exports/chz-token.service";
import { verifyCatalogEnvironment } from "./national-catalog-request-coordinator";

/** Stored-read availability: never requests token renewal or provider work. */
export class NationalCatalogCapabilitiesService {
  constructor(
    private readonly db: Db,
    private readonly tokens: ChzTokenService,
    private readonly env: Env,
  ) {}
  /** Separate stored observations: missing NK configuration does not negate CHZ connectivity. */
  async observeEntitlementConnectivity(
    tenantId: string,
  ): Promise<EntitlementSnapshotV1["connectivity"]> {
    const result: EntitlementSnapshotV1["connectivity"] = {
      observedAt: new Date().toISOString(),
      chz: "unknown",
      nationalCatalog: "unknown",
    };
    try {
      const [row] = await this.db
        .select({ settings: schema.integrationChannels.settings })
        .from(schema.integrationChannels)
        .where(
          and(
            eq(schema.integrationChannels.tenantId, tenantId),
            eq(schema.integrationChannels.type, "chestny_znak"),
          ),
        );
      const settings = chzSignerSettingsSchema.safeParse(row?.settings);
      result.chz =
        settings.success &&
        (await this.tokens.inspectCatalogToken(tenantId, settings.data.environment)) === "ok"
          ? "ready"
          : "not_ready";
    } catch {
      /* A failed observation remains unknown; no provider call or renewal. */
    }
    try {
      result.nationalCatalog =
        (await this.read(tenantId)).connection.state === "ready" ? "ready" : "not_ready";
    } catch {
      /* Preserve the independently observed CHZ state. */
    }
    return result;
  }
  async read(tenantId: string): Promise<CatalogCapabilities> {
    const [row] = await this.db
      .select({ settings: schema.integrationChannels.settings })
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, "chestny_znak"),
        ),
      );
    const settings = chzSignerSettingsSchema.safeParse(row?.settings);
    let connection: CatalogCapabilities["connection"] = {
      state: "missing",
      reason: "integration_missing",
    };
    if (row && !settings.success)
      connection = { state: "blocked", reason: "integration_unavailable" };
    if (settings.success) {
      connection = { state: "blocked", reason: "provider_unconfigured" };
      try {
        verifyCatalogEnvironment(
          settings.data.environment,
          CHZ_TRUE_API_BASE_URLS[settings.data.environment],
          this.env.NATIONAL_CATALOG_BASE_URL ?? "",
        );
        connection = { state: "blocked", reason: "token_unavailable" };
      } catch {
        /* Unsupported endpoint pairing is a safe unavailable connection. */
      }
      if (
        connection.reason === "token_unavailable" &&
        (await this.tokens.inspectCatalogToken(tenantId, settings.data.environment)) === "ok"
      )
        connection = { state: "ready", reason: null };
    }
    const reason = (
      flag: boolean,
      photos = false,
    ): CatalogCapabilities["unavailableReason"]["images"] =>
      !flag
        ? "disabled"
        : connection.state !== "ready"
          ? "connection_unavailable"
          : photos && !this.env.NATIONAL_CATALOG_IMAGE_ALLOWED_HOSTS.length
            ? "image_policy_unavailable"
            : null;
    const unavailableReason = {
      ownCatalog: reason(this.env.NATIONAL_CATALOG_OWN_IMPORT_ENABLED),
      gtinLookup: reason(this.env.NATIONAL_CATALOG_GTIN_IMPORT_ENABLED),
      images: reason(this.env.NATIONAL_CATALOG_IMAGE_IMPORT_ENABLED, true),
    };
    return catalogCapabilitiesSchema.parse({
      ownCatalog: unavailableReason.ownCatalog === null,
      gtinLookup: unavailableReason.gtinLookup === null,
      photos: unavailableReason.images === null,
      connection,
      unavailableReason,
    });
  }
}
