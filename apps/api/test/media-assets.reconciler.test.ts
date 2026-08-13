import type { Db } from "@markiro/db";
import { describe, expect, it, vi } from "vitest";
import { MediaAssetsReconciler } from "../src/modules/media/media-assets.reconciler";
import { MediaAssetsService } from "../src/modules/media/media-assets.service";
import type { ObjectStorageService } from "../src/modules/storage/object-storage.service";

type AssetStatus = "staging" | "active" | "deleting";

interface FakeAsset {
  id: string;
  ownerUserId: string | null;
  ownerTenantId: string | null;
  objectKey: string;
  status: AssetStatus;
  updatedAt: Date;
  referencedBy?: "avatar" | "product";
  referenceAfterClaim?: "avatar" | "product";
  claimLost?: boolean;
}

function asset(overrides: Partial<FakeAsset> & Pick<FakeAsset, "id">): FakeAsset {
  return {
    ownerUserId: "user-1",
    ownerTenantId: null,
    objectKey: `users/user-1/avatars/${overrides.id}.webp`,
    status: "staging",
    updatedAt: new Date("2026-08-13T11:00:00.000Z"),
    ...overrides,
  };
}

function fakeDb(
  initial: FakeAsset[],
  staleBefore = new Date("2026-08-13T11:45:00.000Z"),
): { db: Db; rows: FakeAsset[]; deletedIds: string[] } {
  const rows = initial.map((row) => ({ ...row }));
  const deletedIds: string[] = [];
  let candidates: FakeAsset[] = [];
  let claimIndex = 0;
  let claimed: FakeAsset | undefined;

  const db = {
    select: (fields: Record<string, unknown>) => {
      const query = {
        from: () => query,
        leftJoin: () => query,
        where: () => query,
        limit: async (limit: number) => {
          if ("objectKey" in fields) {
            candidates = rows
              .filter(
                (row) =>
                  (row.status === "staging" || row.status === "deleting") &&
                  row.updatedAt < staleBefore &&
                  row.referencedBy === undefined,
              )
              .slice(0, limit);
            claimIndex = 0;
            return candidates.map(({ referenceAfterClaim: _race, claimLost: _lost, ...row }) => row);
          }
          if (!claimed?.referenceAfterClaim) return [];
          return [
            {
              avatarAssetId: claimed.referenceAfterClaim === "avatar" ? claimed.id : null,
              productAssetId: claimed.referenceAfterClaim === "product" ? claimed.id : null,
            },
          ];
        },
      };
      return query;
    },
    update: () => ({
      set: (values: Partial<FakeAsset>) => ({
        where: () => ({
          returning: async () => {
            const candidate = candidates[claimIndex++];
            claimed = candidate;
            if (!candidate || candidate.claimLost) return [];
            Object.assign(candidate, values);
            return [{ id: candidate.id }];
          },
        }),
      }),
    }),
    delete: () => ({
      where: async () => {
        if (!claimed || claimed.status !== "deleting" || claimed.referenceAfterClaim) {
          return { rowCount: 0 };
        }
        const index = rows.findIndex((row) => row.id === claimed?.id);
        if (index < 0) return { rowCount: 0 };
        const [removed] = rows.splice(index, 1);
        if (removed) deletedIds.push(removed.id);
        return { rowCount: 1 };
      },
    }),
  } as unknown as Db;

  return { db, rows, deletedIds };
}

function fakeStorage(failingKeys: string[] = []) {
  return {
    delete: vi.fn(async (key: string) => {
      if (failingKeys.includes(key)) throw new Error("S3 unavailable");
    }),
  } as unknown as ObjectStorageService;
}

describe("MediaAssetsService", () => {
  it("does not let an immediate-cleanup metadata lookup failure escape", async () => {
    const db = {
      select: () => {
        throw new Error("database lookup unavailable");
      },
    } as unknown as Db;
    const storage = fakeStorage();

    await expect(
      new MediaAssetsService(db, storage).cleanupDeletingTenantAsset("tenant-1", "asset-1"),
    ).resolves.toBeUndefined();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("does not let an immediate-cleanup metadata deletion failure escape after object deletion", async () => {
    let metadataPresent = true;
    const query = {
      from: () => query,
      where: () => query,
      limit: async () => [{ objectKey: "tenants/tenant-1/products/asset-1.webp" }],
    };
    const db = {
      select: () => query,
      delete: () => ({
        where: async () => {
          throw new Error("database delete unavailable");
        },
      }),
    } as unknown as Db;
    const storage = fakeStorage();

    await expect(
      new MediaAssetsService(db, storage).cleanupDeletingTenantAsset("tenant-1", "asset-1"),
    ).resolves.toBeUndefined();
    expect(storage.delete).toHaveBeenCalledWith("tenants/tenant-1/products/asset-1.webp");
    expect(metadataPresent).toBe(true);
  });

  it("reconciles unreferenced stale user and tenant assets without touching aggregate references", async () => {
    const userStaging = asset({ id: "user-staging" });
    const userDeleting = asset({ id: "user-deleting", status: "deleting" });
    const tenantStaging = asset({
      id: "tenant-staging",
      ownerUserId: null,
      ownerTenantId: "tenant-1",
      objectKey: "tenants/tenant-1/products/tenant-staging.webp",
    });
    const tenantDeleting = asset({
      id: "tenant-deleting",
      ownerUserId: null,
      ownerTenantId: "tenant-1",
      objectKey: "tenants/tenant-1/products/tenant-deleting.webp",
      status: "deleting",
    });
    const avatar = asset({ id: "avatar", status: "active", referencedBy: "avatar" });
    const product = asset({
      id: "product",
      ownerUserId: null,
      ownerTenantId: "tenant-1",
      objectKey: "tenants/tenant-1/products/product.webp",
      status: "active",
      referencedBy: "product",
    });
    const state = fakeDb([
      userStaging,
      userDeleting,
      tenantStaging,
      tenantDeleting,
      avatar,
      product,
    ]);
    const storage = fakeStorage();

    const result = await new MediaAssetsService(state.db, storage).reconcile(
      new Date("2026-08-13T12:00:00.000Z"),
    );

    expect(result).toBe(4);
    expect(typeof result).toBe("number");
    expect(storage.delete).toHaveBeenCalledTimes(4);
    expect(storage.delete).toHaveBeenCalledWith(userStaging.objectKey);
    expect(storage.delete).toHaveBeenCalledWith(userDeleting.objectKey);
    expect(storage.delete).toHaveBeenCalledWith(tenantStaging.objectKey);
    expect(storage.delete).toHaveBeenCalledWith(tenantDeleting.objectKey);
    expect(storage.delete).not.toHaveBeenCalledWith(avatar.objectKey);
    expect(storage.delete).not.toHaveBeenCalledWith(product.objectKey);
    expect(state.deletedIds).toEqual([
      "user-staging",
      "user-deleting",
      "tenant-staging",
      "tenant-deleting",
    ]);
    expect(state.rows.map(({ id }) => id)).toEqual(["avatar", "product"]);
  });

  it("skips object deletion when the conditional claim is lost", async () => {
    const candidate = asset({ id: "claim-lost", claimLost: true });
    const state = fakeDb([candidate]);
    const storage = fakeStorage();

    await expect(new MediaAssetsService(state.db, storage).reconcile()).resolves.toBe(0);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(state.deletedIds).toEqual([]);
  });

  it.each(["staging", "deleting"] as const)(
    "retains fresh %s assets until they cross the stale cutoff",
    async (status) => {
      const fresh = asset({
        id: `fresh-${status}`,
        status,
        updatedAt: new Date("2026-08-13T11:50:00.000Z"),
      });
      const state = fakeDb([fresh]);
      const storage = fakeStorage();

      await expect(
        new MediaAssetsService(state.db, storage).reconcile(
          new Date("2026-08-13T12:00:00.000Z"),
        ),
      ).resolves.toBe(0);
      expect(storage.delete).not.toHaveBeenCalled();
      expect(state.rows).toEqual([fresh]);
      expect(state.deletedIds).toEqual([]);
    },
  );

  it.each(["avatar", "product"] as const)(
    "rechecks a %s reference after claiming and before deleting object bytes",
    async (referenceAfterClaim) => {
      const candidate = asset({ id: `${referenceAfterClaim}-race`, referenceAfterClaim });
      const state = fakeDb([candidate]);
      const storage = fakeStorage();

      await expect(new MediaAssetsService(state.db, storage).reconcile()).resolves.toBe(0);
      expect(storage.delete).not.toHaveBeenCalled();
      expect(state.deletedIds).toEqual([]);
    },
  );

  it("retains deleting metadata when object storage deletion fails", async () => {
    const candidate = asset({ id: "storage-failure", status: "staging" });
    const state = fakeDb([candidate]);
    const storage = fakeStorage([candidate.objectKey]);

    await expect(new MediaAssetsService(state.db, storage).reconcile()).resolves.toBe(0);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.status).toBe("deleting");
    expect(state.deletedIds).toEqual([]);
  });
});

describe("MediaAssetsReconciler", () => {
  it("does not block module startup while the single aggregate cleanup is running", async () => {
    let finishCleanup!: (count: number) => void;
    const cleanup = new Promise<number>((resolve) => {
      finishCleanup = resolve;
    });
    const mediaAssets = {
      reconcile: vi.fn().mockReturnValue(cleanup),
    } as unknown as MediaAssetsService;
    const reconciler = new MediaAssetsReconciler(mediaAssets);

    const initialization = reconciler.onModuleInit();

    expect(initialization).toBeUndefined();
    expect(mediaAssets.reconcile).toHaveBeenCalledOnce();

    finishCleanup(0);
    await cleanup;
    reconciler.onModuleDestroy();
  });
});
