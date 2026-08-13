import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KioskBrandingDto, KioskBootstrapDto } from "../src/api/types.js";
import {
  loadCachedBranding,
  refreshCachedBranding,
  type BrandingOwner,
} from "../src/store/branding.js";
import { replaceSnapshot } from "../src/store/cache.js";
import { writeConfig } from "../src/store/config.js";

const SERVER = "https://kiosk.example";
const OWNER: BrandingOwner = {
  serverUrl: SERVER,
  kioskId: "kiosk-1",
  credentialGeneration: "generation-1",
};

function bootstrap(branding: KioskBrandingDto): KioskBootstrapDto {
  return {
    generatedAt: "2026-08-13T08:00:00.000Z",
    subscription: {
      access: "managed",
      status: "active",
      startsAt: null,
      endsAt: null,
    },
    branding,
    pickupPolicy: { limitsEnabled: false },
    config: { dayLimitPerEmployee: 0, showPrices: false },
    badgeSalt: "c2FsdA==",
    reasons: [],
    products: [],
    employees: [],
    operators: [],
  };
}

async function seedBinding(branding: KioskBrandingDto): Promise<BrandingOwner> {
  await replaceSnapshot(bootstrap(branding), new Date("2026-08-13T08:00:01.000Z"));
  const config = await writeConfig({
    serverUrl: SERVER,
    token: "private-token",
    kioskId: "kiosk-1",
    kioskName: "Gate",
    place: null,
    nextDeviceSeq: 0,
  });
  return {
    serverUrl: config.serverUrl,
    kioskId: config.kioskId!,
    credentialGeneration: config.credentialGeneration!,
  };
}

describe("offline kiosk branding", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("uses the organisation name from bootstrap before any logo has been cached", async () => {
    await seedBinding({ organizationName: "Северная вода", logoUrl: null, logoRevision: null });

    await expect(loadCachedBranding()).resolves.toEqual({
      organizationName: "Северная вода",
      logoBlob: null,
      revision: null,
    });
  });

  it("fetches a changed same-origin WebP privately and persists it for offline login", async () => {
    const owner = await seedBinding({
      organizationName: "Северная вода",
      logoUrl: "/kiosk/branding/logo/rev-2",
      logoRevision: "rev-2",
    });
    const logo = new Blob(["valid-webp"], { type: "image/webp" });
    const fetchLogo = vi.fn(
      async () => ({ ok: true, status: 200, blob: async () => logo }) as Response,
    );

    await refreshCachedBranding({
      owner,
      token: "private-token",
      branding: bootstrap({
        organizationName: "Северная вода",
        logoUrl: "/kiosk/branding/logo/rev-2",
        logoRevision: "rev-2",
      }).branding,
      fetch: fetchLogo as typeof fetch,
      decode: async () => true,
    });

    expect(fetchLogo).toHaveBeenCalledWith(
      "https://kiosk.example/kiosk/branding/logo/rev-2",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-kiosk-token": "private-token" }),
      }),
    );
    await expect(loadCachedBranding()).resolves.toEqual({
      organizationName: "Северная вода",
      logoBlob: logo,
      revision: "rev-2",
    });
  });

  it("keeps the prior valid blob when a refresh fails or returns an undecodable image", async () => {
    const owner = await seedBinding({
      organizationName: "Северная вода",
      logoUrl: "/kiosk/branding/logo/rev-1",
      logoRevision: "rev-1",
    });
    const oldLogo = new Blob(["old"], { type: "image/webp" });
    await refreshCachedBranding({
      owner,
      token: "private-token",
      branding: {
        organizationName: "Северная вода",
        logoUrl: "/kiosk/branding/logo/rev-1",
        logoRevision: "rev-1",
      },
      fetch: vi.fn(
        async () => ({ ok: true, blob: async () => oldLogo }) as Response,
      ) as typeof fetch,
      decode: async () => true,
    });
    await replaceSnapshot(
      bootstrap({
        organizationName: "Северная вода — новая",
        logoUrl: "/kiosk/branding/logo/rev-2",
        logoRevision: "rev-2",
      }),
      new Date("2026-08-13T08:01:00.000Z"),
    );

    await refreshCachedBranding({
      owner,
      token: "private-token",
      branding: {
        organizationName: "Северная вода — новая",
        logoUrl: "/kiosk/branding/logo/rev-2",
        logoRevision: "rev-2",
      },
      fetch: vi.fn(async () => {
        throw new TypeError("offline");
      }) as typeof fetch,
      decode: async () => true,
    });
    await refreshCachedBranding({
      owner,
      token: "private-token",
      branding: {
        organizationName: "Северная вода — новая",
        logoUrl: "/kiosk/branding/logo/rev-2",
        logoRevision: "rev-2",
      },
      fetch: vi.fn(
        async () =>
          ({
            ok: true,
            blob: async () => new Blob(["broken"], { type: "image/webp" }),
          }) as Response,
      ) as typeof fetch,
      decode: async () => false,
    });

    await expect(loadCachedBranding()).resolves.toEqual({
      organizationName: "Северная вода — новая",
      logoBlob: oldLogo,
      revision: "rev-1",
    });
  });

  it("never requests a cross-origin logo and does not expose a previous binding's blob", async () => {
    const fetchLogo = vi.fn();
    await expect(
      refreshCachedBranding({
        owner: OWNER,
        token: "private-token",
        branding: {
          organizationName: "Новый tenant",
          logoUrl: "https://tracker.invalid/pixel.webp",
          logoRevision: "rev-x",
        },
        fetch: fetchLogo as typeof fetch,
        decode: async () => true,
      }),
    ).resolves.toEqual({ organizationName: "Новый tenant", logoBlob: null, revision: null });
    expect(fetchLogo).not.toHaveBeenCalled();
  });
});
