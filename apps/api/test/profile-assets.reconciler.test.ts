import { describe, expect, it, vi } from "vitest";
import { ProfileAssetsReconciler } from "../src/modules/profile/profile-assets.reconciler";
import type { OrgProfileService } from "../src/modules/org-profile/org-profile.service";
import type { ProfileService } from "../src/modules/profile/profile.service";

describe("ProfileAssetsReconciler", () => {
  it("does not block module startup while the first storage cleanup is running", async () => {
    let finishCleanup!: (count: number) => void;
    const cleanup = new Promise<number>((resolve) => {
      finishCleanup = resolve;
    });
    const profiles = {
      reconcileAssets: vi.fn().mockReturnValue(cleanup),
    } as unknown as ProfileService;
    const organizations = {
      reconcileLogoAssets: vi.fn().mockResolvedValue(0),
    } as unknown as OrgProfileService;
    const reconciler = new ProfileAssetsReconciler(profiles, organizations);

    const initialization = reconciler.onModuleInit();

    expect(initialization).toBeUndefined();
    expect(profiles.reconcileAssets).toHaveBeenCalledOnce();
    expect(organizations.reconcileLogoAssets).toHaveBeenCalledOnce();

    finishCleanup(0);
    await cleanup;
    reconciler.onModuleDestroy();
  });
});
