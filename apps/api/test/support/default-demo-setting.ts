import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";

type DefaultDemoTransaction = Parameters<Db["transaction"]>[0] extends (arg: infer T) => unknown
  ? T
  : never;

/**
 * Owns a test's temporary singleton value and restores it only while that
 * exact random catalog version is still current. A concurrent legitimate
 * change therefore wins instead of being overwritten by teardown.
 */
export class DefaultDemoSettingFixture {
  private originalVersionId: string | null | undefined;
  private installedVersionId: string | undefined;

  constructor(private readonly db: Db) {}

  async capture(): Promise<void> {
    if (this.originalVersionId !== undefined) throw new Error("Default demo already captured");
    this.originalVersionId = await this.db.transaction(async (tx) => {
      await lockSetting(tx);
      const [setting] = await tx
        .select({ versionId: schema.platformSettings.defaultDemoCatalogVersionId })
        .from(schema.platformSettings)
        .where(eq(schema.platformSettings.key, "default"));
      return setting?.versionId ?? null;
    });
  }

  async install(versionId: string): Promise<void> {
    if (this.originalVersionId === undefined) throw new Error("Default demo was not captured");
    await this.db.transaction(async (tx) => {
      await lockCatalogVersion(tx, versionId);
      await lockSetting(tx);
      await tx
        .insert(schema.platformSettings)
        .values({ key: "default", defaultDemoCatalogVersionId: versionId })
        .onConflictDoUpdate({
          target: schema.platformSettings.key,
          set: { defaultDemoCatalogVersionId: versionId, updatedAt: new Date() },
        });
    });
    this.installedVersionId = versionId;
  }

  async restore(): Promise<boolean> {
    if (this.originalVersionId === undefined) throw new Error("Default demo was not captured");
    const expectedVersionId = this.installedVersionId;
    if (!expectedVersionId) return false;
    const originalVersionId = this.originalVersionId;
    const restored = await this.db.transaction(async (tx) => {
      if (originalVersionId) await lockCatalogVersion(tx, originalVersionId);
      await lockSetting(tx);
      const [current] = await tx
        .select({ versionId: schema.platformSettings.defaultDemoCatalogVersionId })
        .from(schema.platformSettings)
        .where(eq(schema.platformSettings.key, "default"));
      if (current?.versionId !== expectedVersionId) return false;
      if (originalVersionId) {
        const changed = await tx
          .update(schema.platformSettings)
          .set({ defaultDemoCatalogVersionId: originalVersionId, updatedAt: new Date() })
          .where(
            and(
              eq(schema.platformSettings.key, "default"),
              eq(schema.platformSettings.defaultDemoCatalogVersionId, expectedVersionId),
            ),
          )
          .returning({ key: schema.platformSettings.key });
        return changed.length === 1;
      }
      const deleted = await tx
        .delete(schema.platformSettings)
        .where(
          and(
            eq(schema.platformSettings.key, "default"),
            eq(schema.platformSettings.defaultDemoCatalogVersionId, expectedVersionId),
          ),
        )
        .returning({ key: schema.platformSettings.key });
      return deleted.length === 1;
    });
    if (restored) this.installedVersionId = undefined;
    return restored;
  }
}

async function lockCatalogVersion(tx: DefaultDemoTransaction, versionId: string): Promise<void> {
  await tx.execute(sql`select id from catalog_item_versions where id = ${versionId} for key share`);
}

async function lockSetting(tx: DefaultDemoTransaction): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('platform-default-demo-setting', 0))`,
  );
  await tx.execute(sql`select key from platform_settings where key = 'default' for update`);
}
